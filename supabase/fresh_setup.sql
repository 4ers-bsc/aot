-- ============================================================================
-- Age of Trenches — FRESH SETUP (run this on a clean Supabase project)
-- Drop everything first, then rebuild with all fixes applied.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 0. Teardown
-- ---------------------------------------------------------------------------
drop trigger if exists on_auth_user_created on auth.users;

drop function if exists public.close_stale_matches();
drop function if exists public.apply_match_result(uuid, uuid);
drop function if exists public.claim_payout_slot(uuid);
drop function if exists public.finish_match(uuid, int);
drop function if exists public.finish_match(uuid, uuid);
drop function if exists public.record_deposit(uuid, text);
drop function if exists public.join_pvp_match(smallint, text, text);
drop function if exists public.join_pvp_match(smallint, text);
drop function if exists public.leave_my_matches();
drop function if exists public.level_for_points(integer);
drop function if exists public.sync_my_profile(text);
drop function if exists public.is_match_member(uuid);
drop function if exists public.handle_new_user();

drop table if exists public.match_players cascade;
drop table if exists public.matches        cascade;
drop table if exists public.profiles       cascade;

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------------
-- 1. Tables
-- ---------------------------------------------------------------------------
create table public.profiles (
  user_id      uuid primary key references auth.users(id) on delete cascade,
  display_name text not null default 'Trench Rookie'
    check (char_length(display_name) between 3 and 24),
  wallet_address text,
  wins         integer not null default 0,
  losses       integer not null default 0,
  games_played integer not null default 0,
  points       integer not null default 0,
  level        integer not null default 1,
  win_streak   integer not null default 0,
  best_streak  integer not null default 0,
  created_at   timestamptz not null default timezone('utc', now())
);

create table public.matches (
  id             uuid primary key default gen_random_uuid(),
  status         text not null default 'waiting'
    check (status in ('waiting', 'active', 'finished')),
  -- Fix: restrict to the three supported lobby sizes (2, 5, 10)
  max_players    smallint not null default 2
    check (max_players in (2, 5, 10)),
  created_by     uuid references auth.users(id) on delete set null,
  winner_user_id uuid references auth.users(id) on delete set null,
  created_at     timestamptz not null default timezone('utc', now()),
  started_at     timestamptz,
  ended_at       timestamptz,
  pot_tokens     bigint not null default 0,
  payout_tx      text,
  payout_claimed_at timestamptz
);

create table public.match_players (
  match_id     uuid not null references public.matches(id) on delete cascade,
  user_id      uuid not null references auth.users(id) on delete cascade,
  seat         smallint not null check (seat between 1 and 10),
  display_name text not null,
  joined_at    timestamptz not null default timezone('utc', now()),
  deposit_tx   text,
  final_hp     int,
  primary key (match_id, user_id),
  unique (match_id, seat),
  -- Fix: prevents two players recording the same on-chain signature
  unique (deposit_tx)
);

create index if not exists idx_matches_waiting    on public.matches(status, created_at);
create index if not exists idx_match_players_user on public.match_players(user_id, joined_at desc);

-- ---------------------------------------------------------------------------
-- 2. Auto-create profile on sign-up
-- ---------------------------------------------------------------------------
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (user_id, display_name)
  values (new.id, coalesce(new.raw_user_meta_data ->> 'display_name', 'Trench Rookie'))
  on conflict (user_id) do nothing;
  return new;
end;
$$;

create trigger on_auth_user_created
after insert on auth.users
for each row execute function public.handle_new_user();

-- ---------------------------------------------------------------------------
-- 3. Helpers
-- ---------------------------------------------------------------------------
create or replace function public.is_match_member(p_match_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.match_players
    where match_id = p_match_id and user_id = auth.uid()
  );
$$;

create or replace function public.sync_my_profile(p_display_name text default null)
returns public.profiles
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_uid     uuid := auth.uid();
  v_wallet  text;
  v_profile public.profiles%rowtype;
begin
  if v_uid is null then
    raise exception 'not_authenticated';
  end if;

  select provider_id into v_wallet
  from auth.identities
  where user_id = v_uid
  order by coalesce(last_sign_in_at, created_at) desc
  limit 1;

  insert into public.profiles as p (user_id, display_name, wallet_address)
  values (v_uid, coalesce(nullif(trim(p_display_name), ''), 'Trench Rookie'), v_wallet)
  on conflict (user_id) do update
  set display_name   = coalesce(nullif(trim(p_display_name), ''), p.display_name),
      wallet_address = coalesce(excluded.wallet_address, p.wallet_address)
  where p.user_id = v_uid
  returning * into v_profile;

  return v_profile;
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. join_pvp_match — deposit-before-join (deposit tx required at call time)
-- ---------------------------------------------------------------------------
create or replace function public.join_pvp_match(
  p_max_players  smallint default 2,
  p_deposit_tx   text     default null,
  p_display_name text     default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_uid        uuid     := auth.uid();
  v_name       text;
  v_size       smallint := least(greatest(coalesce(p_max_players, 2), 2), 10);
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

  -- Clamp to the three supported lobby sizes
  if v_size not in (2, 5, 10) then
    v_size := 2;
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
      'status',      'existing',
      'max_players', v_existing.max_players
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

    insert into public.match_players (match_id, user_id, seat, display_name, deposit_tx)
    values (v_match_id, v_uid, v_seat, v_name, p_deposit_tx);

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
  insert into public.match_players (match_id, user_id, seat, display_name, deposit_tx)
  values (v_match_id, v_uid, v_seat, v_name, p_deposit_tx);

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

-- ---------------------------------------------------------------------------
-- 5. leave_my_matches
-- ---------------------------------------------------------------------------
create or replace function public.leave_my_matches()
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid      uuid := auth.uid();
  r          record;
  v_remaining integer;
begin
  if v_uid is null then
    raise exception 'not_authenticated';
  end if;

  for r in
    select m.id, m.status
    from public.matches m
    join public.match_players mp on mp.match_id = m.id
    where mp.user_id = v_uid and m.status in ('waiting', 'active')
  loop
    if r.status = 'waiting' then
      delete from public.match_players where match_id = r.id and user_id = v_uid;
      select count(*) into v_remaining from public.match_players where match_id = r.id;
      if v_remaining = 0 then
        update public.matches set status = 'finished', ended_at = timezone('utc', now()) where id = r.id;
      end if;
    end if;
  end loop;
end;
$$;

-- ---------------------------------------------------------------------------
-- 6. record_deposit — retained for backward compatibility
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
  c_entry_fee    constant bigint := 2500000000;
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

  if v_existing_tx is not null and v_existing_tx <> p_deposit_tx then
    raise exception 'already_deposited';
  end if;

  if v_existing_tx = p_deposit_tx then
    return;
  end if;

  update public.match_players
  set deposit_tx = p_deposit_tx
  where match_id = p_match_id and user_id = v_uid;

  update public.matches
  set pot_tokens = pot_tokens + c_entry_fee
  where id = p_match_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- 7. level_for_points
-- ---------------------------------------------------------------------------
create or replace function public.level_for_points(p integer)
returns integer
language sql
immutable
as $$
  select greatest(1, floor((1 + sqrt(1 + 0.08 * greatest(p, 0))) / 2)::int);
$$;

-- ---------------------------------------------------------------------------
-- 8. apply_match_result — shared stats helper called by finish_match and
--    close_stale_matches so stats are never skipped.
-- ---------------------------------------------------------------------------
create or replace function public.apply_match_result(p_match_id uuid, p_winner_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_streak     integer;
  v_win_points integer;
begin
  -- Losers: +1 loss, +1 game, +10 points, streak reset
  update public.profiles p set
    losses       = p.losses + 1,
    games_played = p.games_played + 1,
    win_streak   = 0,
    points       = p.points + 10,
    level        = public.level_for_points(p.points + 10)
  where p.user_id in (
    select user_id from public.match_players
    where match_id = p_match_id and user_id <> p_winner_id
  );

  -- Winner: +1 win, +1 game, +60 base + 10 x streak bonus
  select win_streak + 1 into v_streak from public.profiles where user_id = p_winner_id;
  v_win_points := 60 + greatest(0, v_streak - 1) * 10;
  update public.profiles p set
    wins         = p.wins + 1,
    games_played = p.games_played + 1,
    win_streak   = v_streak,
    best_streak  = greatest(p.best_streak, v_streak),
    points       = p.points + v_win_points,
    level        = public.level_for_points(p.points + v_win_points)
  where p.user_id = p_winner_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- 9. finish_match — server-authoritative (HP-based winner)
--    Fix 1: stats updates restored (wins/losses/points/level/streak)
--    Fix 3: fast-crown requires ALL other players to have reported hp=0,
--           not just "exactly 1 alive" — prevents fake-HP exploit
-- ---------------------------------------------------------------------------
create or replace function public.finish_match(p_match_id uuid, p_final_hp int default 0)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_caller      uuid := auth.uid();
  v_status      text;
  v_winner      uuid;
  v_alive_count int;
  v_dead_count  int;
  v_total       int;
begin
  if v_caller is null then
    raise exception 'not_authenticated';
  end if;

  if not exists (
    select 1 from match_players
    where match_id = p_match_id and user_id = v_caller
  ) then
    raise exception 'not_a_participant';
  end if;

  -- Record caller's HP (clamped 0–100)
  update match_players
  set final_hp = greatest(0, least(100, p_final_hp))
  where match_id = p_match_id and user_id = v_caller;

  -- Lock the row to prevent concurrent finalisations
  select status into v_status from matches where id = p_match_id for update;
  if v_status = 'finished' then return; end if;
  if v_status is null       then raise exception 'match_not_found'; end if;

  select count(*) into v_total
  from match_players
  where match_id = p_match_id;

  select count(*) into v_alive_count
  from match_players
  where match_id = p_match_id and final_hp is not null and final_hp > 0;

  select count(*) into v_dead_count
  from match_players
  where match_id = p_match_id and final_hp is not null and final_hp = 0;

  -- Fix 3: only fast-crown when exactly 1 alive AND all others have confirmed dead.
  -- This blocks a cheating player from claiming hp=100 while opponents haven't
  -- yet reported — they must all be explicitly confirmed dead before the winner
  -- is known. Disconnected losers are handled by close_stale_matches.
  if v_alive_count = 1 and v_dead_count = v_total - 1 then
    select user_id into v_winner
    from match_players
    where match_id = p_match_id and final_hp > 0
    limit 1;

    update matches
    set winner_user_id = v_winner, status = 'finished', ended_at = now()
    where id = p_match_id and status != 'finished';

    perform public.apply_match_result(p_match_id, v_winner);
    return;
  end if;

  -- All players have reported (none null) — use highest HP; seat ASC breaks ties.
  if not exists (
    select 1 from match_players
    where match_id = p_match_id and final_hp is null
  ) then
    select user_id into v_winner
    from match_players
    where match_id = p_match_id
    order by final_hp desc, seat asc
    limit 1;

    update matches
    set winner_user_id = v_winner, status = 'finished', ended_at = now()
    where id = p_match_id and status != 'finished';

    perform public.apply_match_result(p_match_id, v_winner);
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- 10. claim_payout_slot — atomic single UPDATE
--     Fix 8: stale-release and new claim happen in one statement so two
--     concurrent callers cannot both succeed.
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
  set payout_tx = 'pending', payout_claimed_at = now()
  where id             = p_match_id
    and status         = 'finished'
    and winner_user_id = v_uid
    and (
      payout_tx is null
      or (payout_tx = 'pending' and payout_claimed_at < now() - interval '10 minutes')
    );

  return found;
end;
$$;

-- ---------------------------------------------------------------------------
-- 11. close_stale_matches — cron-based TTL for abandoned active matches
--     Fix 1: applies profile stats via apply_match_result
--     Fix 6: winner is NULL (no award) when no HP has been reported at all,
--            instead of auto-awarding the match creator
-- ---------------------------------------------------------------------------
create or replace function public.close_stale_matches()
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_closed int := 0;
  r        record;
begin
  for r in
    select
      m.id,
      -- Fix 6: only pick a winner from players who actually reported an HP;
      -- if nobody reported, winner_uid is NULL (no prize awarded).
      (
        select mp.user_id
        from   match_players mp
        where  mp.match_id = m.id
          and  mp.final_hp is not null
        order  by mp.final_hp desc, mp.seat asc
        limit  1
      ) as winner_uid
    from matches m
    where m.status     = 'active'
      and m.started_at is not null
      and m.started_at < now() - (
        case m.max_players
          when 2  then interval '10 minutes'
          when 5  then interval '15 minutes'
          when 10 then interval '20 minutes'
          else         interval '20 minutes'
        end
      )
    for update of m skip locked
  loop
    update matches
    set    status         = 'finished',
           winner_user_id = r.winner_uid,
           ended_at       = now()
    where  id = r.id
      and  status != 'finished';

    if found and r.winner_uid is not null then
      perform public.apply_match_result(r.id, r.winner_uid);
    end if;

    v_closed := v_closed + 1;
  end loop;

  return v_closed;
end;
$$;

-- ---------------------------------------------------------------------------
-- 12. Row-level security
-- ---------------------------------------------------------------------------
alter table public.profiles     enable row level security;
alter table public.matches      enable row level security;
alter table public.match_players enable row level security;

-- Profiles: own row only
create policy "profiles_select_own"
on public.profiles for select to authenticated
using (auth.uid() = user_id);

create policy "profiles_update_own_name"
on public.profiles for update to authenticated
using (auth.uid() = user_id)
with check (auth.uid() = user_id);

-- Matches: visible when active or you are a member
create policy "matches_select_member_or_active"
on public.matches for select to authenticated
using (status = 'active' or public.is_match_member(id));

-- Match players: visible when active or you are in the match
create policy "match_players_select_member_or_active"
on public.match_players for select to authenticated
using (
  public.is_match_member(match_id)
  or exists (select 1 from public.matches m where m.id = match_id and m.status = 'active')
);

-- ---------------------------------------------------------------------------
-- 13. Grants
-- ---------------------------------------------------------------------------
grant select, update(display_name) on public.profiles to authenticated;
grant select on public.matches      to authenticated;
grant select on public.match_players to authenticated;

grant execute on function public.sync_my_profile(text)                 to authenticated;
grant execute on function public.join_pvp_match(smallint, text, text)  to authenticated;
grant execute on function public.leave_my_matches()                    to authenticated;
grant execute on function public.finish_match(uuid, int)               to authenticated;
grant execute on function public.claim_payout_slot(uuid)               to authenticated;
grant execute on function public.record_deposit(uuid, text)            to authenticated;
grant execute on function public.level_for_points(integer)             to authenticated;

-- apply_match_result and close_stale_matches are internal / service_role only
grant execute on function public.apply_match_result(uuid, uuid)  to service_role;
grant execute on function public.close_stale_matches()           to service_role;

-- ---------------------------------------------------------------------------
-- 14. pg_cron — schedule stale-match sweeper every 5 minutes (optional)
--     Run this separately ONLY if pg_cron is enabled on your Supabase project.
-- ---------------------------------------------------------------------------
-- select cron.schedule('close-stale', '*/5 * * * *', 'select public.close_stale_matches()');
