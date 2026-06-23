-- Security hardening: deposit guard, winner-must-be-caller, pot column rename,
-- and a payout-slot reservation helper used by the edge function.

-- ---------------------------------------------------------------------------
-- 1. Rename pot_lamports → pot_tokens (it stores raw SPL token units, not SOL)
-- ---------------------------------------------------------------------------
alter table public.matches
  rename column pot_lamports to pot_tokens;

-- ---------------------------------------------------------------------------
-- 2. record_deposit — prevent overwriting a valid deposit signature
-- ---------------------------------------------------------------------------
create or replace function public.record_deposit(p_match_id uuid, p_deposit_tx text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid          uuid := auth.uid();
  v_existing_tx  text;
  c_entry_fee    constant bigint := 2500000000; -- 2500 × 10^6
begin
  if v_uid is null then
    raise exception 'not_authenticated';
  end if;

  if p_deposit_tx is null or trim(p_deposit_tx) = '' then
    raise exception 'invalid_deposit_tx';
  end if;

  if not exists (
    select 1 from public.match_players
    where match_id = p_match_id and user_id = v_uid
  ) then
    raise exception 'not_in_match';
  end if;

  select deposit_tx into v_existing_tx
  from public.match_players
  where match_id = p_match_id and user_id = v_uid;

  -- Reject if a *different* signature was already recorded
  if v_existing_tx is not null and v_existing_tx <> p_deposit_tx then
    raise exception 'already_deposited';
  end if;

  -- Idempotent: same sig re-submitted, nothing to do
  if v_existing_tx = p_deposit_tx then
    return;
  end if;

  -- First deposit
  update public.match_players
  set deposit_tx = p_deposit_tx
  where match_id = p_match_id and user_id = v_uid;

  update public.matches
  set pot_tokens = pot_tokens + c_entry_fee
  where id = p_match_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- 3. finish_match — winner must equal the authenticated caller
--    (prevents any match participant from falsely reporting someone else as winner)
-- ---------------------------------------------------------------------------
create or replace function public.finish_match(p_match_id uuid, p_winner_user_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid        uuid := auth.uid();
  v_status     text;
  v_streak     integer;
  v_win_points integer;
begin
  if v_uid is null then
    raise exception 'not_authenticated';
  end if;

  -- Only the player claiming the win may call this
  if p_winner_user_id <> v_uid then
    raise exception 'winner_must_be_caller';
  end if;

  if not exists (
    select 1 from public.match_players
    where match_id = p_match_id and user_id = v_uid
  ) then
    raise exception 'not_in_match';
  end if;

  select status into v_status from public.matches where id = p_match_id for update;
  if v_status is null then
    raise exception 'match_not_found';
  end if;
  if v_status <> 'active' then
    return; -- already settled, idempotent
  end if;

  update public.matches
  set status = 'finished', winner_user_id = p_winner_user_id, ended_at = timezone('utc', now())
  where id = p_match_id;

  -- Losers: +1 loss, +1 game, +10 points, streak reset
  update public.profiles p set
    losses       = p.losses + 1,
    games_played = p.games_played + 1,
    win_streak   = 0,
    points       = p.points + 10,
    level        = public.level_for_points(p.points + 10)
  where p.user_id in (
    select user_id from public.match_players
    where match_id = p_match_id and user_id <> p_winner_user_id
  );

  -- Winner: +1 win, +1 game, +60 base, +10 × streak bonus
  select win_streak + 1 into v_streak from public.profiles where user_id = p_winner_user_id;
  v_win_points := 60 + greatest(0, v_streak - 1) * 10;
  update public.profiles p set
    wins         = p.wins + 1,
    games_played = p.games_played + 1,
    win_streak   = v_streak,
    best_streak  = greatest(p.best_streak, v_streak),
    points       = p.points + v_win_points,
    level        = public.level_for_points(p.points + v_win_points)
  where p.user_id = p_winner_user_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. claim_payout_slot — atomic reservation used by the edge function to
--    prevent two concurrent payout requests from both sending a transaction.
--    Sets payout_tx = 'pending' and returns true only if the row was updated.
--    The edge function replaces 'pending' with the real sig on success, or
--    clears it back to NULL on failure.
-- ---------------------------------------------------------------------------
create or replace function public.claim_payout_slot(p_match_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
begin
  update public.matches
  set payout_tx = 'pending'
  where id         = p_match_id
    and status     = 'finished'
    and winner_user_id = v_uid
    and payout_tx is null;

  return found;
end;
$$;

grant execute on function public.claim_payout_slot(uuid) to authenticated;
grant execute on function public.record_deposit(uuid, text) to authenticated;
