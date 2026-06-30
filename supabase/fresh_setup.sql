-- ============================================================================
-- FIGHT10 — FRESH SETUP (run this on a clean Supabase project)
-- Drop everything first, then rebuild with all fixes applied.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 0. Teardown
-- ---------------------------------------------------------------------------
drop trigger if exists on_auth_user_created on auth.users;

drop function if exists public.close_stale_matches();
drop function if exists public.compute_shadow_winner(uuid);
drop function if exists public.match_duration_seconds(smallint);
drop function if exists public.apply_match_result(uuid, uuid);
drop function if exists public.claim_payout_slot(uuid);
drop function if exists public.finalize_match(uuid, boolean);
drop function if exists public.finalize_match(uuid);
drop function if exists public.finish_match(uuid, int);
drop function if exists public.finish_match(uuid, uuid);
drop function if exists public.record_deposit(uuid, text);
drop function if exists public.join_pvp_match(uuid, smallint, text, text, text);
drop function if exists public.join_pvp_match(smallint, text, text, text);
drop function if exists public.join_pvp_match(smallint, text, text);
drop function if exists public.join_pvp_match(smallint, text);
drop function if exists public.leave_my_matches();
drop function if exists public.level_for_points(integer);
drop function if exists public.sync_my_profile(text);
drop function if exists public.is_match_member(uuid) cascade;
drop function if exists public.handle_new_user();

drop table if exists public.match_config   cascade;
drop table if exists public.match_damage   cascade;
drop table if exists public.match_kills    cascade;
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
  -- Friendly sequential match number (1, 2, 3, …). The UUID stays the key;
  -- this is just a human-readable identifier.
  match_no       bigint generated always as identity,
  status         text not null default 'waiting'
    check (status in ('waiting', 'active', 'finished', 'disputed')),
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
  payout_claimed_at timestamptz,
  stats_applied  boolean not null default false,
  -- Option A (Phase 0 shadow): ledger-derived winner, recorded for comparison
  -- against winner_user_id. Does not affect payouts yet.
  shadow_winner  uuid references auth.users(id) on delete set null,
  shadow_meta    jsonb
);

create table public.match_players (
  match_id     uuid not null references public.matches(id) on delete cascade,
  user_id      uuid not null references auth.users(id) on delete cascade,
  seat         smallint not null check (seat between 1 and 10),
  display_name text not null,
  joined_at    timestamptz not null default timezone('utc', now()),
  deposit_tx   text,
  -- The wallet that actually signed the on-chain deposit. May differ from the
  -- player's login wallet (profiles.wallet_address) when they deposit from a
  -- different connected wallet, so the payout function verifies against this.
  deposit_wallet text,
  final_hp     int,
  primary key (match_id, user_id),
  unique (match_id, seat),
  -- Fix: prevents two players recording the same on-chain signature
  unique (deposit_tx)
);

-- Option A combat ledger — each player records only the damage THEY dealt.
-- RLS (section 11) forces attacker = auth.uid(), so a player can never write
-- their own incoming HP or edit another player's row.
create table public.match_damage (
  match_id     uuid   not null references public.matches(id) on delete cascade,
  attacker     uuid   not null references auth.users(id) on delete cascade,
  victim       uuid   not null references auth.users(id) on delete cascade,
  total_damage int    not null check (total_damage between 0 and 100000),
  hit_count    int    not null check (hit_count >= 0),
  first_t_ms   bigint not null default 0,
  last_t_ms    bigint not null default 0,
  created_at   timestamptz not null default now(),
  primary key (match_id, attacker, victim),
  check (attacker <> victim)
);

create table public.match_kills (
  match_id   uuid   not null references public.matches(id) on delete cascade,
  attacker   uuid   not null references auth.users(id) on delete cascade,
  victim     uuid   not null references auth.users(id) on delete cascade,
  t_ms       bigint not null default 0,
  created_at timestamptz not null default now(),
  primary key (match_id, victim),  -- a player dies once; first kill claim wins
  check (attacker <> victim)
);

-- Single source of truth for per-lobby match duration (read by both the
-- server settler and the client countdown). Edit a row to change match length.
create table public.match_config (
  max_players      smallint primary key check (max_players in (2, 5, 10)),
  duration_seconds int not null check (duration_seconds between 30 and 3600)
);
insert into public.match_config (max_players, duration_seconds) values
  (2,  300),   -- 5 min
  (5,  420),   -- 7 min
  (10, 600);   -- 10 min

create unique index if not exists idx_matches_match_no on public.matches(match_no);
create index if not exists idx_matches_waiting    on public.matches(status, created_at);
create index if not exists idx_match_players_user on public.match_players(user_id, joined_at desc);
create index if not exists idx_match_players_match on public.match_players(match_id);
create index if not exists idx_match_damage_match  on public.match_damage(match_id);
create index if not exists idx_match_kills_match   on public.match_kills(match_id);

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
-- 4. join_pvp_match — deposit-before-join, verified server-side.
--    Service-role only: the f10join edge function verifies the deposit tx
--    on-chain BEFORE calling this, so an unverified tx can never take a seat.
--    The browser must NOT call this RPC directly (see grants below).
-- ---------------------------------------------------------------------------
create or replace function public.join_pvp_match(
  p_user_id        uuid,
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
  v_uid          uuid     := p_user_id;
  v_name         text;
  v_login_wallet text;
  v_size         smallint := coalesce(p_max_players, 2);
  v_match_id     uuid;
  v_seat         smallint;
  v_count        smallint;
  v_status       text;
  v_existing     record;
  c_entry_fee    constant bigint := 2500000000; -- 2500 × 10^6 (6-decimal mint)
begin
  -- p_user_id is supplied by the edge function from the verified JWT. This RPC
  -- is service-role only, so v_uid is trusted.
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

  -- Refresh the profile (display name + login wallet) for this user. We can't use
  -- sync_my_profile() here because it relies on auth.uid(); this function runs as
  -- the service role from the edge function, so we upsert against p_user_id.
  insert into public.profiles as p (user_id, display_name, wallet_address)
  values (
    v_uid,
    coalesce(nullif(trim(p_display_name), ''), 'Trench Rookie'),
    (select provider_id from auth.identities
       where user_id = v_uid
       order by coalesce(last_sign_in_at, created_at) desc
       limit 1)
  )
  on conflict (user_id) do update
  set display_name   = coalesce(nullif(trim(p_display_name), ''), p.display_name),
      wallet_address = coalesce(excluded.wallet_address, p.wallet_address)
  where p.user_id = v_uid
  returning display_name, wallet_address into v_name, v_login_wallet;

  -- One wallet per player: the wallet that signs the deposit MUST be the same
  -- wallet the player signed in with. Both values may carry a "chain:" prefix
  -- (e.g. "solana:<pubkey>"), so compare only the trailing pubkey segment.
  if v_login_wallet is null
     or regexp_replace(trim(v_login_wallet),  '^.*:', '')
      <> regexp_replace(trim(p_deposit_wallet), '^.*:', '') then
    raise exception 'deposit_wallet_mismatch: deposit must come from your signed-in wallet';
  end if;

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
    -- Gap-resilient seat assignment: take the lowest seat number (1..size) not
    -- currently occupied. `count + 1` would collide with unique (match_id, seat)
    -- when an earlier player left and freed a middle seat.
    select min(s) into v_seat
    from   generate_series(1, v_size) s
    where  s not in (select seat from public.match_players where match_id = v_match_id);

    insert into public.match_players (match_id, user_id, seat, display_name, deposit_tx, deposit_wallet)
    values (v_match_id, v_uid, v_seat, v_name, p_deposit_tx, trim(p_deposit_wallet));

    update public.matches
    set pot_tokens = pot_tokens + c_entry_fee
    where id = v_match_id;

    -- Activate once every seat is filled. Use the player count, not the seat
    -- index, since seats may have been filled out of order after a gap.
    select count(*) into v_count from public.match_players where match_id = v_match_id;
    if v_count >= v_size then
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
  v_uid         uuid := auth.uid();
  r             record;
  v_remaining   integer;
  v_had_deposit boolean;
  c_entry_fee   constant bigint := 2500000000;
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
      select (deposit_tx is not null) into v_had_deposit
      from public.match_players
      where match_id = r.id and user_id = v_uid;

      delete from public.match_players where match_id = r.id and user_id = v_uid;

      if v_had_deposit then
        update public.matches
        set pot_tokens = greatest(0, pot_tokens - c_entry_fee)
        where id = r.id;
      end if;

      select count(*) into v_remaining from public.match_players where match_id = r.id;
      if v_remaining = 0 then
        update public.matches set status = 'finished', ended_at = timezone('utc', now()) where id = r.id;
      end if;
    end if;
  end loop;
end;
$$;

-- ---------------------------------------------------------------------------
-- 6. level_for_points
-- ---------------------------------------------------------------------------
create or replace function public.level_for_points(p integer)
returns integer
language sql
immutable
as $$
  select least(30, greatest(1, floor((1 + sqrt(1 + 0.08 * greatest(p, 0))) / 2)::int));
$$;

-- ---------------------------------------------------------------------------
-- 6b. match_duration_seconds — per-lobby match length from match_config,
--     with a safe fallback. Single source for the server deadline + client timer.
-- ---------------------------------------------------------------------------
create or replace function public.match_duration_seconds(p_max_players smallint)
returns int
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    (select duration_seconds from public.match_config where max_players = p_max_players),
    300
  );
$$;

-- ---------------------------------------------------------------------------
-- 7. apply_match_result — shared stats helper called by finish_match and
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
  -- Idempotency guard: only apply stats once per match
  update public.matches
  set stats_applied = true
  where id = p_match_id and not stats_applied;

  if not found then
    return;
  end if;

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
-- 8a. finish_match — records ONE player's final HP. Nothing else.
--     Single responsibility: a player reports their result. Winner selection,
--     stats and match closure are deferred to finalize_match, which this calls
--     automatically so the match settles the moment the last report lands.
-- ---------------------------------------------------------------------------
create or replace function public.finish_match(p_match_id uuid, p_final_hp int default 0)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_caller uuid := auth.uid();
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

  -- Record caller's HP (clamped 0–100). This is finish_match's only side effect.
  update match_players
  set final_hp = greatest(0, least(100, p_final_hp))
  where match_id = p_match_id and user_id = v_caller;

  -- Attempt to settle the match. finalize_match is a no-op unless enough
  -- players have reported, so it is safe to call on every report.
  perform public.finalize_match(p_match_id);
end;
$$;

-- ---------------------------------------------------------------------------
-- 8b. finalize_match — LEDGER-AUTHORITATIVE settlement (Option A, Phase 2).
--     Decides the winner from match_damage, not from self-reported final_hp.
--     Each player's HP = 100 − the validated damage OTHERS reported dealing
--     them, so a client cannot inflate its own survival. Two caps reject
--     impossible offense: a per-pair cap and a per-attacker TOTAL-output cap
--     (which catches one player deleting several rivals at once). If the
--     would-be winner dealt impossible damage, or no clean winner exists, or
--     no combat happened, the match is marked 'disputed' (no winner, no
--     payout). p_force settles on timeout even if players never reported.
-- ---------------------------------------------------------------------------
create or replace function public.finalize_match(p_match_id uuid, p_force boolean default false)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_status     text;
  v_maxp       smallint;
  v_started    timestamptz;
  v_deadline   timestamptz;
  v_ended      timestamptz;
  v_secs       numeric;
  v_unreported int;
  v_dmg_total  bigint;
  v_winner     uuid;
  v_disputed   boolean := false;
  v_meta       jsonb;
  -- Physical ceilings (buffer over real stats: sword ~40 dps, ~1.4 hits/s).
  c_max_dps      constant numeric := 50;   -- per attacker, total across all victims
  c_max_firerate constant numeric := 4;    -- hits per second, per attacker→victim pair
begin
  select status, started_at, max_players into v_status, v_started, v_maxp
  from matches where id = p_match_id for update;
  if v_status is null                     then raise exception 'match_not_found'; end if;
  if v_status in ('finished', 'disputed') then return; end if;

  -- Hard cap from match_config (per lobby size). Before it, hold open until
  -- everyone reports; after it (or on force), settle from the ledger now.
  v_deadline := coalesce(v_started, now()) + make_interval(secs => public.match_duration_seconds(v_maxp));

  select count(*) filter (where final_hp is null) into v_unreported
  from match_players where match_id = p_match_id;

  if not p_force and v_unreported > 0 and now() < v_deadline then
    return;
  end if;

  v_ended := now();
  v_secs  := greatest(5, extract(epoch from (v_ended - coalesce(v_started, v_ended))));

  select coalesce(sum(total_damage), 0) into v_dmg_total
  from match_damage where match_id = p_match_id;

  if v_dmg_total = 0 then
    -- No combat recorded → no real contest.
    update matches
      set status = 'disputed', winner_user_id = NULL, ended_at = v_ended,
          shadow_winner = NULL,
          shadow_meta = jsonb_build_object('reason', 'no_combat', 'secs', v_secs)
      where id = p_match_id and status not in ('finished', 'disputed');
    return;
  end if;

  with raw as (
    -- win_secs = how long this attacker→victim damage actually spanned, so the
    -- cap is a RATE. A match may run 5 min, but damage dealt in a 2s burst is
    -- still capped at 2s worth — this is what catches a burst insta-kill.
    select attacker, victim, total_damage, hit_count,
           greatest(2, (last_t_ms - first_t_ms) / 1000.0) as win_secs
    from match_damage where match_id = p_match_id
  ),
  attacker_totals as (
    select attacker,
           sum(total_damage) as out_total,
           greatest(2, (max(last_t_ms) - min(first_t_ms)) / 1000.0) as out_secs
    from match_damage where match_id = p_match_id
    group by attacker
  ),
  flagged as (
    select attacker from attacker_totals
    where out_total > (c_max_dps * out_secs)
  ),
  valid as (
    select victim, least(total_damage, (c_max_dps * win_secs)::int) as dmg
    from raw
    where hit_count <= c_max_firerate * win_secs
  ),
  hp as (
    select mp.user_id, mp.seat,
           greatest(0, 100 - coalesce(sum(v.dmg), 0))::int as hp
    from match_players mp
    left join valid v on v.victim = mp.user_id
    group by mp.user_id, mp.seat
  ),
  ranked as (
    select user_id, hp, seat,
           row_number() over (order by hp desc, seat asc) as rn
    from hp
  )
  select
    (select user_id from ranked where rn = 1),
    exists (select 1 from flagged f join ranked r on r.user_id = f.attacker and r.rn = 1),
    jsonb_build_object(
      'secs',  v_secs,
      'caps',  jsonb_build_object('dps', c_max_dps, 'firerate', c_max_firerate),
      'hp',    (select jsonb_agg(jsonb_build_object('user_id', user_id, 'hp', hp, 'seat', seat)
                                 order by hp desc, seat asc) from ranked),
      'flagged',      (select coalesce(jsonb_agg(attacker), '[]'::jsonb) from flagged),
      'attacker_out', (select jsonb_object_agg(attacker::text, out_total) from attacker_totals)
    )
    into v_winner, v_disputed, v_meta;

  if v_winner is null then v_disputed := true; end if;

  if v_disputed then
    update matches
      set status = 'disputed', winner_user_id = NULL, ended_at = v_ended,
          shadow_winner = v_winner, shadow_meta = v_meta
      where id = p_match_id and status not in ('finished', 'disputed');
  else
    update matches
      set status = 'finished', winner_user_id = v_winner, ended_at = v_ended,
          shadow_winner = v_winner, shadow_meta = v_meta
      where id = p_match_id and status not in ('finished', 'disputed');
    if found then
      perform public.apply_match_result(p_match_id, v_winner);
    end if;
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- 9. claim_payout_slot — atomic single UPDATE
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
-- 10. close_stale_matches — backstop for the hard 5-minute cap. Force-settles
--     any match still active past started_at + 5 min through the authoritative
--     ledger settler, for the case where every client vanished and no
--     finish_match arrived at the deadline.
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
    select m.id
    from matches m
    where m.status     = 'active'
      and m.started_at is not null
      and m.started_at < now() - make_interval(secs => public.match_duration_seconds(m.max_players))
    for update of m skip locked
  loop
    perform public.finalize_match(r.id, true);
    v_closed := v_closed + 1;
  end loop;

  return v_closed;
end;
$$;

-- ---------------------------------------------------------------------------
-- 11. Row-level security
-- ---------------------------------------------------------------------------
alter table public.profiles     enable row level security;
alter table public.matches      enable row level security;
alter table public.match_players enable row level security;
alter table public.match_damage enable row level security;
alter table public.match_kills  enable row level security;
alter table public.match_config enable row level security;

-- Match config: world-readable (non-sensitive; clients read it to set the timer).
create policy "match_config_select_all"
on public.match_config for select to authenticated, anon using (true);

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
using (status in ('active', 'waiting') or public.is_match_member(id));

-- Match players: visible when active or you are in the match
create policy "match_players_select_member_or_active"
on public.match_players for select to authenticated
using (
  public.is_match_member(match_id)
  or exists (select 1 from public.matches m where m.id = match_id and m.status = 'active')
);

-- Combat ledger: you may only INSERT rows where you are the attacker (so you
-- can never report your own incoming HP), and only read your own matches.
create policy "match_damage_insert_own"
on public.match_damage for insert to authenticated
with check (attacker = auth.uid() and public.is_match_member(match_id));

create policy "match_damage_select_member"
on public.match_damage for select to authenticated
using (public.is_match_member(match_id));

create policy "match_kills_insert_own"
on public.match_kills for insert to authenticated
with check (attacker = auth.uid() and public.is_match_member(match_id));

create policy "match_kills_select_member"
on public.match_kills for select to authenticated
using (public.is_match_member(match_id));

-- ---------------------------------------------------------------------------
-- 12. Grants
-- ---------------------------------------------------------------------------
grant select, update(display_name) on public.profiles to authenticated;
grant select on public.matches      to authenticated;
grant select on public.match_players to authenticated;
grant select, insert on public.match_damage to authenticated;
grant select, insert on public.match_kills  to authenticated;
grant select on public.match_config to authenticated, anon;

grant execute on function public.sync_my_profile(text)                 to authenticated;
-- join_pvp_match is service-role only: the f10join edge function verifies the
-- deposit on-chain BEFORE calling it, so the browser cannot admit an unverified
-- deposit by calling the RPC directly.
revoke all on function public.join_pvp_match(uuid, smallint, text, text, text) from public, anon, authenticated;
grant execute on function public.join_pvp_match(uuid, smallint, text, text, text) to service_role;
grant execute on function public.leave_my_matches()                    to authenticated;
grant execute on function public.finish_match(uuid, int)               to authenticated;
grant execute on function public.claim_payout_slot(uuid)               to authenticated;
grant execute on function public.level_for_points(integer)             to authenticated;
grant execute on function public.match_duration_seconds(smallint)      to authenticated, service_role, anon;

-- apply_match_result, finalize_match and close_stale_matches are internal:
-- finalize_match is only ever called from finish_match (a security-definer
-- function), so it never needs a direct grant to authenticated.
grant execute on function public.apply_match_result(uuid, uuid)    to service_role;
grant execute on function public.finalize_match(uuid, boolean)     to service_role;
grant execute on function public.close_stale_matches()             to service_role;

-- ---------------------------------------------------------------------------
-- 14. pg_cron — backstop sweeper. Runs every minute so an abandoned match
--     settles within ~1 min of its hard 5-minute cap. Strongly recommended:
--     without it, a match where every client vanished never settles.
--     Run this separately ONLY if pg_cron is enabled on your Supabase project.
-- ---------------------------------------------------------------------------
-- select cron.schedule('close-stale', '* * * * *', 'select public.close_stale_matches()');
