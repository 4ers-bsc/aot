-- ---------------------------------------------------------------------------
-- Migration: record the wallet that signed each on-chain deposit.
--
-- The payout function (f10treasurer) verifies that each deposit's on-chain
-- transfer authority matches the player. Previously it compared against the
-- player's *login* wallet (profiles.wallet_address), which fails when a player
-- deposits from a different connected wallet than the one they authenticated
-- with. We now record the actual depositing wallet at join time and verify
-- against that.
--
-- Safe to run on an existing database. Run in the Supabase SQL editor.
-- ---------------------------------------------------------------------------

-- 1. Add the column (nullable; existing rows stay null and must be backfilled
--    manually if those matches still need to pay out — see note at bottom).
alter table public.match_players
  add column if not exists deposit_wallet text;

-- 2. Replace join_pvp_match with a signature that accepts the depositing wallet.
drop function if exists public.join_pvp_match(smallint, text, text, text);
drop function if exists public.join_pvp_match(smallint, text, text);
drop function if exists public.join_pvp_match(smallint, text);

create or replace function public.join_pvp_match(
  p_max_players    smallint default 2,
  p_deposit_tx     text     default null,
  p_display_name   text     default null,
  p_deposit_wallet text     default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_uid        uuid     := auth.uid();
  v_name       text;
  v_size       smallint := coalesce(p_max_players, 2);
  v_match_id   uuid;
  v_seat       smallint;
  v_count      smallint;
  v_status     text;
  v_existing   record;
  c_entry_fee  constant bigint := 2500000000; -- 2500 × 10^6 (6-decimal mint)
begin
  if v_uid is null then
    raise exception 'not_authenticated';
  end if;

  if p_deposit_tx is null or trim(p_deposit_tx) = '' then
    raise exception 'deposit_tx_required';
  end if;

  if p_deposit_wallet is null or trim(p_deposit_wallet) = '' then
    raise exception 'deposit_wallet_required';
  end if;

  -- Reject unsupported lobby sizes instead of silently converting
  if v_size not in (2, 5, 10) then
    raise exception 'invalid_max_players: must be 2, 5, or 10';
  end if;

  select display_name into v_name
  from public.sync_my_profile(p_display_name);

  -- One wallet, one unfinished match at a time — return existing seat
  select mp.match_id, mp.seat, m.status, m.max_players
  into   v_existing
  from   public.match_players mp
  join   public.matches m on m.id = mp.match_id
  where  mp.user_id = v_uid
    and  m.status in ('waiting', 'active')
  limit 1;

  if found then
    return jsonb_build_object(
      'match_id',    v_existing.match_id,
      'seat',        v_existing.seat,
      'status',      v_existing.status,
      'max_players', v_existing.max_players,
      'rejoining',   true
    );
  end if;

  -- Find a waiting match of the right size with a free seat, lock it
  select m.id into v_match_id
  from   public.matches m
  where  m.status      = 'waiting'
    and  m.max_players = v_size
    and  (select count(*) from public.match_players mp where mp.match_id = m.id) < m.max_players
  order  by m.created_at
  for update of m skip locked
  limit  1;

  if found then
    select count(*) into v_count from public.match_players where match_id = v_match_id;
    v_seat := v_count + 1;

    insert into public.match_players (match_id, user_id, seat, display_name, deposit_tx, deposit_wallet)
    values (v_match_id, v_uid, v_seat, v_name, p_deposit_tx, trim(p_deposit_wallet));

    update public.matches
    set pot_tokens = pot_tokens + c_entry_fee
    where id = v_match_id;

    -- Last seat filled → all players have paid → activate
    if v_seat >= v_size then
      update public.matches
      set status = 'active', started_at = timezone('utc', now())
      where id = v_match_id;
      v_status := 'active';
    else
      v_status := 'waiting';
    end if;

    return jsonb_build_object(
      'match_id',    v_match_id,
      'seat',        v_seat,
      'status',      v_status,
      'max_players', v_size
    );
  end if;

  -- No waiting match found — open a new one
  insert into public.matches (status, max_players, created_by)
  values ('waiting', v_size, v_uid)
  returning id into v_match_id;

  v_seat := 1;
  insert into public.match_players (match_id, user_id, seat, display_name, deposit_tx, deposit_wallet)
  values (v_match_id, v_uid, v_seat, v_name, p_deposit_tx, trim(p_deposit_wallet));

  update public.matches
  set pot_tokens = pot_tokens + c_entry_fee
  where id = v_match_id;

  return jsonb_build_object(
    'match_id',    v_match_id,
    'seat',        v_seat,
    'status',      'waiting',
    'max_players', v_size
  );
end;
$$;

grant execute on function public.join_pvp_match(smallint, text, text, text) to authenticated;

-- ---------------------------------------------------------------------------
-- NOTE: matches created before this migration have deposit_wallet = null and
-- will fail payout verification ("depositing wallet was not recorded at join
-- time"). To pay one out, backfill the column with the on-chain transfer
-- authority of each player's deposit_tx, e.g.:
--
--   update public.match_players
--   set deposit_wallet = '<authority-pubkey-from-deposit_tx>'
--   where match_id = '<match-id>' and user_id = '<user-id>';
-- ---------------------------------------------------------------------------
