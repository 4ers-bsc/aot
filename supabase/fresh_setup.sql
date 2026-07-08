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
drop function if exists public.pvp_capacity();
drop function if exists public.leave_my_matches();
drop function if exists public.level_for_points(integer);
drop function if exists public.get_leaderboard(integer);
drop function if exists public.get_leaderboard(integer, text);
drop function if exists public.get_holdings_wallets(integer);
drop function if exists public.sync_my_profile(text);
drop function if exists public.is_match_member(uuid) cascade;
drop function if exists public.handle_new_user();
drop function if exists public.enforce_rate_limit(text, int, interval);
drop function if exists public.report_integrity_signal(uuid, text, jsonb);
drop function if exists public.is_banned(uuid);
drop function if exists public.ban_user(uuid, text);
drop function if exists public.ban_forfeited() cascade;
drop function if exists public.validate_match_damage() cascade;
drop function if exists public.validate_match_kills() cascade;

drop table if exists public.review_notes     cascade;
drop table if exists public.banned_users    cascade;
drop table if exists public.consumed_deposits cascade;
drop table if exists public.payouts          cascade;
drop table if exists public.integrity_signals cascade;
drop table if exists public.rate_limits      cascade;
drop table if exists public.match_config   cascade;
drop table if exists public.match_damage   cascade;
drop table if exists public.match_kills    cascade;
drop table if exists public.match_players cascade;
drop table if exists public.matches        cascade;
drop table if exists public.profiles       cascade;

-- Dropped after profiles: the display_name column default depends on it.
drop function if exists public.generate_unique_username();

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------------
-- 1. Tables
-- ---------------------------------------------------------------------------
create table public.profiles (
  user_id      uuid primary key references auth.users(id) on delete cascade,
  -- Unique per player, case-insensitively (see idx_profiles_display_name_ci).
  -- The default is set to generate_unique_username() in §2, once it exists.
  display_name text not null
    check (char_length(display_name) between 3 and 24),
  wallet_address text,
  wins         integer not null default 0,
  losses       integer not null default 0,
  games_played integer not null default 0,
  points       integer not null default 0,
  level        integer not null default 1,
  win_streak   integer not null default 0,
  best_streak  integer not null default 0,
  -- Default character: the saved skin preference (1 = Fighter, 2 = Knight)
  skin_id      smallint not null default 1
    check (skin_id in (1, 2)),
  -- Skins available to this player; server-managed (no client update grant)
  skins        smallint[] not null default '{1,2}'
    check (skins <@ array[1, 2]::smallint[]),
  created_at   timestamptz not null default timezone('utc', now()),
  -- The saved preference must be a skin the player actually has
  constraint profiles_skin_in_skins check (skin_id = any (skins))
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
  shadow_meta    jsonb,
  -- Players forfeited for impossible combat output (set by finalize_match). They
  -- are excluded from winner selection so an honest opponent still wins.
  forfeited_user_ids uuid[] not null default '{}'
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
  -- Liveness heartbeat: clients update this every few seconds while in an active
  -- match. A stale value marks the player disconnected (see finalize_match).
  last_seen    timestamptz not null default timezone('utc', now()),
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

-- Per-user rate limiting (anti-abuse). Touched only by enforce_rate_limit().
create table public.rate_limits (
  user_id      uuid        not null references auth.users(id) on delete cascade,
  action       text        not null,
  window_start timestamptz not null default now(),
  count        int         not null default 0,
  primary key (user_id, action)
);

-- Soft anti-cheat telemetry (e.g. devtools opened). For review only — never
-- auto-forfeits. Written via report_integrity_signal(); read by admins.
create table public.integrity_signals (
  id         bigint generated always as identity primary key,
  user_id    uuid references auth.users(id) on delete set null,
  match_id   uuid references public.matches(id) on delete set null,
  kind       text not null,
  detail     jsonb,
  created_at timestamptz not null default now()
);

-- Payout ledger — one record per winning payout with the on-chain tx signature,
-- surfaced as an explorer link in the victory screen and match history. Written
-- by the payout edge function (service role); matches.payout_tx stays the claim
-- source of truth.
create table public.payouts (
  match_id       uuid     not null references public.matches(id) on delete cascade,
  winner_user_id uuid     not null references auth.users(id) on delete cascade,
  payout_tx      text     not null,
  amount_raw     bigint   not null,
  decimals       smallint not null default 6,
  num_players    int      not null default 0,
  created_at     timestamptz not null default now(),
  primary key (match_id)
);
create index if not exists idx_payouts_winner on public.payouts(winner_user_id, created_at desc);

-- Deposit signatures are single-use, permanently. unique(deposit_tx) on
-- match_players only holds while the seat row exists (leaving a waiting lobby
-- deletes it), so join_pvp_match also records every signature here the moment
-- it takes a seat and rejects any signature seen before. Rows are never deleted.
create table public.consumed_deposits (
  deposit_tx  text primary key,
  user_id     uuid references auth.users(id)      on delete set null,
  match_id    uuid references public.matches(id)  on delete set null,
  consumed_at timestamptz not null default now()
);

-- Banned accounts — cannot join or play. Set automatically on forfeit for
-- impossible combat output, or by the edge functions on non-browser requests.
create table public.banned_users (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  wallet     text,
  reason     text,
  created_at timestamptz not null default now()
);

-- Admin review notes — free-text operator notes on a match / user / payout,
-- recording how a dispute, ban or stuck payout was resolved. Written/read only
-- by the f10admin edge function (service role); RLS on with no policies blocks
-- all direct client access. See migrations/20260712_admin_review_notes.sql.
create table public.review_notes (
  id           bigint generated always as identity primary key,
  subject_type text not null
    check (subject_type in ('match', 'user', 'payout', 'deposit', 'waiting', 'general')),
  subject_id   text,
  note         text not null check (char_length(note) between 1 and 2000),
  action       text,
  author_id    uuid references auth.users(id) on delete set null,
  created_at   timestamptz not null default now()
);
create index if not exists idx_review_notes_subject
  on public.review_notes (subject_type, subject_id, created_at desc);
create index if not exists idx_review_notes_created
  on public.review_notes (created_at desc);

create unique index if not exists idx_matches_match_no on public.matches(match_no);
-- No two profiles may hold the same username in any letter case, whatever
-- code path wrote it. All name writers pre-check against this and fall back
-- (or raise 'username_taken') instead of surfacing a raw unique violation.
create unique index if not exists idx_profiles_display_name_ci
  on public.profiles (lower(display_name));

create index if not exists idx_matches_waiting    on public.matches(status, created_at);
create index if not exists idx_match_players_user on public.match_players(user_id, joined_at desc);
create index if not exists idx_match_players_match on public.match_players(match_id);
create index if not exists idx_match_damage_match  on public.match_damage(match_id);
create index if not exists idx_match_kills_match   on public.match_kills(match_id);

-- ---------------------------------------------------------------------------
-- 2. Auto-create profile on sign-up (with a unique generated username)
-- ---------------------------------------------------------------------------
-- Random unique handle, e.g. "IronRaider-4821". Longest combination is
-- 7+7+5 = 19 chars, inside the 3–24 display_name check. security definer so
-- the existence check sees every profile regardless of RLS.
create or replace function public.generate_unique_username()
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_adjectives constant text[] := array[
    'Iron','Grim','Swift','Feral','Stone','Blood','Night','Storm',
    'Rusty','Silent','Savage','Crimson','Shadow','Vicious','Rogue','Bold'];
  v_nouns constant text[] := array[
    'Rookie','Raider','Brawler','Slayer','Titan','Reaper','Fang','Blade',
    'Hound','Viper','Golem','Jackal','Wraith','Bruiser','Nomad','Duke'];
  v_name text;
begin
  for i in 1..25 loop
    v_name := v_adjectives[1 + floor(random() * array_length(v_adjectives, 1))::int]
           || v_nouns[1 + floor(random() * array_length(v_nouns, 1))::int]
           || '-' || lpad(floor(random() * 10000)::int::text, 4, '0');
    if not exists (
      select 1 from public.profiles where lower(display_name) = lower(v_name)
    ) then
      return v_name;
    end if;
  end loop;
  -- 2.56M combinations; if 25 straight draws collide, fall back to an
  -- id-derived name that cannot.
  return 'Player-' || replace(substr(gen_random_uuid()::text, 1, 13), '-', '');
end;
$$;

-- A bare insert gets a generated unique name, never a shared literal default.
alter table public.profiles
  alter column display_name set default public.generate_unique_username();

-- A requested metadata name that is already taken (or no name at all) falls
-- back to a generated unique one.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_requested text := nullif(trim(new.raw_user_meta_data ->> 'display_name'), '');
begin
  if v_requested is not null and exists (
    select 1 from public.profiles where lower(display_name) = lower(v_requested)
  ) then
    v_requested := null;
  end if;

  begin
    insert into public.profiles (user_id, display_name)
    values (new.id, coalesce(v_requested, public.generate_unique_username()))
    on conflict (user_id) do nothing;
  exception when unique_violation then
    -- Lost a race for the requested name; sign-up must still succeed.
    insert into public.profiles (user_id, display_name)
    values (new.id, public.generate_unique_username())
    on conflict (user_id) do nothing;
  end;
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

-- The player-facing save path. A name held by another wallet is rejected with
-- 'username_taken' so the profile dialog can say so.
create or replace function public.sync_my_profile(p_display_name text default null)
returns public.profiles
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_uid       uuid := auth.uid();
  v_wallet    text;
  v_requested text := nullif(trim(p_display_name), '');
  v_profile   public.profiles%rowtype;
begin
  if v_uid is null then
    raise exception 'not_authenticated';
  end if;

  if v_requested is not null and exists (
    select 1 from public.profiles
    where lower(display_name) = lower(v_requested) and user_id <> v_uid
  ) then
    raise exception 'username_taken: that username is already in use';
  end if;

  select provider_id into v_wallet
  from auth.identities
  where user_id = v_uid
  order by coalesce(last_sign_in_at, created_at) desc
  limit 1;

  begin
    insert into public.profiles as p (user_id, display_name, wallet_address)
    values (v_uid, coalesce(v_requested, public.generate_unique_username()), v_wallet)
    on conflict (user_id) do update
    set display_name   = coalesce(v_requested, p.display_name),
        wallet_address = coalesce(excluded.wallet_address, p.wallet_address)
    where p.user_id = v_uid
    returning * into v_profile;
  exception when unique_violation then
    -- Two saves raced for the same name; the pre-check above missed it.
    raise exception 'username_taken: that username is already in use';
  end;

  return v_profile;
end;
$$;

-- enforce_rate_limit — sliding-window per-user throttle. Raises 'rate_limited'
-- when the caller exceeds p_max calls for p_action within p_window.
create or replace function public.enforce_rate_limit(
  p_action text,
  p_max    int,
  p_window interval
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid   uuid := auth.uid();
  v_count int;
begin
  if v_uid is null then
    raise exception 'not_authenticated';
  end if;

  insert into public.rate_limits as rl (user_id, action, window_start, count)
  values (v_uid, p_action, now(), 1)
  on conflict (user_id, action) do update
    set count = case when rl.window_start < now() - p_window then 1
                     else rl.count + 1 end,
        window_start = case when rl.window_start < now() - p_window then now()
                            else rl.window_start end
  returning count into v_count;

  if v_count > p_max then
    raise exception 'rate_limited: too many % requests', p_action;
  end if;
end;
$$;

-- is_banned / ban_user — account bans. ban_user records the wallet and ejects the
-- account from any open match (combined with RLS, this neutralises them).
create or replace function public.is_banned(p_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (select 1 from public.banned_users where user_id = p_user_id);
$$;

create or replace function public.ban_user(p_user_id uuid, p_reason text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_user_id is null then return; end if;

  insert into public.banned_users (user_id, wallet, reason)
  values (
    p_user_id,
    (select wallet_address from public.profiles where user_id = p_user_id),
    left(coalesce(p_reason, 'violation'), 200)
  )
  on conflict (user_id) do nothing;

  delete from public.match_players mp
  using public.matches m
  where mp.user_id = p_user_id
    and mp.match_id = m.id
    and m.status in ('waiting', 'active');
end;
$$;

-- Auto-ban players forfeited for impossible combat output (set by finalize_match
-- in matches.forfeited_user_ids). Runs in a trigger so the ban commits with the
-- settlement.
create or replace function public.ban_forfeited()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  u uuid;
begin
  foreach u in array new.forfeited_user_ids loop
    perform public.ban_user(u, 'impossible_combat_output');
  end loop;
  return new;
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
  v_requested    text;
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

  if public.is_banned(v_uid) then
    raise exception 'banned: this account is banned from play';
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
  -- A requested name already held by another wallet is ignored — joining must
  -- never fail over a username.
  v_requested := nullif(trim(p_display_name), '');
  if v_requested is not null and exists (
       select 1 from public.profiles
       where lower(display_name) = lower(v_requested) and user_id <> v_uid
     ) then
    v_requested := null;
  end if;

  begin
    insert into public.profiles as p (user_id, display_name, wallet_address)
    values (
      v_uid,
      coalesce(v_requested, public.generate_unique_username()),
      (select provider_id from auth.identities
         where user_id = v_uid
         order by coalesce(last_sign_in_at, created_at) desc
         limit 1)
    )
    on conflict (user_id) do update
    set display_name   = coalesce(v_requested, p.display_name),
        wallet_address = coalesce(excluded.wallet_address, p.wallet_address)
    where p.user_id = v_uid
    returning display_name, wallet_address into v_name, v_login_wallet;
  exception when unique_violation then
    -- Lost a race for the requested name; keep the current name instead.
    insert into public.profiles as p (user_id, display_name, wallet_address)
    values (
      v_uid,
      public.generate_unique_username(),
      (select provider_id from auth.identities
         where user_id = v_uid
         order by coalesce(last_sign_in_at, created_at) desc
         limit 1)
    )
    on conflict (user_id) do update
    set wallet_address = coalesce(excluded.wallet_address, p.wallet_address)
    where p.user_id = v_uid
    returning display_name, wallet_address into v_name, v_login_wallet;
  end;

  -- One wallet per player: the wallet that signs the deposit MUST be the same
  -- wallet the player signed in with. Both values may carry a "chain:" prefix
  -- (e.g. "solana:<pubkey>"), so compare only the trailing pubkey segment.
  if v_login_wallet is null
     or regexp_replace(trim(v_login_wallet),  '^.*:', '')
      <> regexp_replace(trim(p_deposit_wallet), '^.*:', '') then
    raise exception 'deposit_wallet_mismatch: deposit must come from your signed-in wallet';
  end if;

  -- One wallet, one unfinished match at a time — return the existing seat, but
  -- only when that match is genuinely still live. A disconnected player's old
  -- match can be over in all but status (every client gone, nobody nudged
  -- settlement), which would otherwise bounce them into a dead match forever.
  select mp.match_id, mp.seat, m.status, m.max_players, m.started_at
  into   v_existing
  from   public.match_players mp
  join   public.matches m on m.id = mp.match_id
  where  mp.user_id = v_uid
    and  m.status in ('waiting', 'active')
  limit 1;

  if found and v_existing.status = 'active' then
    -- Settle the old match if it is actually over: force past the hard time
    -- cap, heartbeat-based otherwise (settles only when every player has
    -- reported or gone stale; a live match is untouched). Idempotent.
    perform public.finalize_match(
      v_existing.match_id,
      v_existing.started_at is not null
        and now() >= v_existing.started_at
                     + make_interval(secs => public.match_duration_seconds(v_existing.max_players))
    );

    -- Re-check: if finalize settled it (finished/disputed) the seat no longer
    -- blocks and the player joins fresh below.
    select mp.match_id, mp.seat, m.status, m.max_players, m.started_at
    into   v_existing
    from   public.match_players mp
    join   public.matches m on m.id = mp.match_id
    where  mp.user_id = v_uid
      and  m.status in ('waiting', 'active')
    limit 1;
  end if;

  if found then
    return jsonb_build_object(
      'match_id',    v_existing.match_id,
      'seat',        v_existing.seat,
      'status',      v_existing.status,
      'max_players', v_existing.max_players,
      'rejoining',   true
    );
  end if;

  -- Deposits are single-use, permanently. unique(deposit_tx) on match_players
  -- only holds while the seat row exists (leaving a waiting lobby deletes it),
  -- so a NEW seat must also be checked against the permanent ledger. Runs
  -- after the rejoin block so a lost-response retry still gets its seat back.
  if exists (select 1 from public.consumed_deposits where deposit_tx = p_deposit_tx) then
    raise exception 'deposit_already_used: this deposit was already spent on a match entry';
  end if;

  -- Global capacity cap: never seat more than 150 wallets across all live
  -- matches at once. Only applies to a NEW seat (rejoins already returned
  -- above). The client checks pvp_capacity() before charging the entry fee
  -- so this should rarely trip, but it's the authoritative check — the
  -- client-side one is advisory only. An advisory lock serializes concurrent
  -- callers here so a burst of simultaneous joins can't all read the same
  -- under-cap count and overshoot together; it's released automatically at
  -- the end of this transaction.
  perform pg_advisory_xact_lock(hashtext('fight10_pvp_capacity'));
  if (select count(*) from public.match_players mp
      join public.matches m on m.id = mp.match_id
      where m.status in ('waiting', 'active')) >= public.pvp_capacity_cap() then
    raise exception 'servers_full: % player cap reached, try again shortly', public.pvp_capacity_cap();
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

    insert into public.consumed_deposits (deposit_tx, user_id, match_id)
    values (p_deposit_tx, v_uid, v_match_id);

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

  insert into public.consumed_deposits (deposit_tx, user_id, match_id)
  values (p_deposit_tx, v_uid, v_match_id);

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
-- 4b. pvp_capacity / pvp_capacity_cap — global concurrent-player cap.
--     The cap lives in one place (this function) so join_pvp_match's
--     authoritative check and the client's pre-payment check can't drift.
--     Bump the constant here to change the cap; no other code references it.
-- ---------------------------------------------------------------------------
create or replace function public.pvp_capacity_cap()
returns int
language sql
immutable
as $$
  select 150;
$$;

-- Public, RLS-free read of how many wallets currently hold a live match seat.
-- match_players/matches RLS only exposes 'active' matches to non-members
-- (not 'waiting' lobbies), so a plain client-side count would undercount —
-- this security definer function reports the true global total instead.
-- Client-side only: it lets the client warn (and skip charging the
-- non-refundable entry fee) before a wallet ever joins a full queue. The
-- authoritative check is the one inside join_pvp_match itself.
create or replace function public.pvp_capacity()
returns jsonb
language sql
security definer
set search_path = public
stable
as $$
  select jsonb_build_object(
    'active', (select count(*) from public.match_players mp
               join public.matches m on m.id = mp.match_id
               where m.status in ('waiting', 'active')),
    'cap',    public.pvp_capacity_cap()
  );
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
-- 6a. get_leaderboard — public leaderboard (points and wins tabs).
--     profiles RLS only exposes a player's own row, so the leaderboard is
--     served by this security definer RPC. It returns only display data
--     (name, level, points, wins, losses) — never user_id or wallet_address —
--     plus an is_me flag computed server-side so the client can highlight the
--     caller's row without the RPC leaking anyone's identity.
--     p_sort: 'points' (default) ranks by points; 'wins' ranks by wins with
--     win% as the tiebreaker.
-- ---------------------------------------------------------------------------
create or replace function public.get_leaderboard(
  p_limit integer default 20,
  p_sort  text    default 'points'
)
returns table (
  rank         bigint,
  display_name text,
  level        integer,
  points       integer,
  wins         integer,
  losses       integer,
  is_me        boolean
)
language sql
security definer
set search_path = public
stable
as $$
  with ranked as (
    select p.display_name,
           p.level,
           p.points,
           p.wins,
           p.losses,
           coalesce(p.user_id = auth.uid(), false) as is_me,
           p.created_at,
           p.wins::numeric / nullif(p.wins + p.losses, 0) as win_pct
    from public.profiles p
  )
  select row_number() over (
           order by
             case when p_sort = 'wins' then r.wins else r.points end desc,
             case when p_sort = 'wins' then r.win_pct end desc nulls last,
             case when p_sort = 'wins' then r.points else r.wins end desc,
             r.created_at asc
         ) as rank,
         r.display_name, r.level, r.points, r.wins, r.losses, r.is_me
  from ranked r
  order by
    case when p_sort = 'wins' then r.wins else r.points end desc,
    case when p_sort = 'wins' then r.win_pct end desc nulls last,
    case when p_sort = 'wins' then r.points else r.wins end desc,
    r.created_at asc
  limit least(greatest(coalesce(p_limit, 20), 1), 100);
$$;

-- ---------------------------------------------------------------------------
-- 6a-bis. get_holdings_wallets — backs the leaderboard's $FIGHT10 tab.
--     Balances live on-chain, so the client ranks wallets by balance itself;
--     this RPC hands it the wallet addresses to look up. Exposing
--     wallet_address here is deliberate: a holdings leaderboard only works by
--     linking fighters to their (already public) on-chain wallets. It still
--     never exposes user_id.
-- ---------------------------------------------------------------------------
create or replace function public.get_holdings_wallets(p_limit integer default 100)
returns table (
  display_name   text,
  level          integer,
  wallet_address text,
  is_me          boolean
)
language sql
security definer
set search_path = public
stable
as $$
  select p.display_name,
         p.level,
         p.wallet_address,
         coalesce(p.user_id = auth.uid(), false) as is_me
  from public.profiles p
  where p.wallet_address is not null
  order by p.points desc, p.created_at asc
  limit least(greatest(coalesce(p_limit, 100), 1), 100);
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

  -- Throttle abuse: normally called once per match; 30/min is a generous ceiling.
  perform public.enforce_rate_limit('finish_match', 30, interval '1 minute');

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
--     CANONICAL DEFINITION. Kept byte-for-byte in sync with the incremental
--     migration supabase/migrations/20260716_ledger_corroboration.sql —
--     edit both together (this is the from-scratch path; that is the upgrade
--     path for already-provisioned databases).
--     Decides the winner from match_damage, not from self-reported final_hp.
--     Each player's HP = 100 − the validated damage OTHERS reported dealing
--     them, so a client cannot inflate its own survival. Two caps reject
--     impossible offense: a per-pair cap and a per-attacker TOTAL-output cap
--     (which catches one player deleting several rivals at once). Flagged
--     cheaters are FORFEITED — excluded from winner selection so the best clean
--     player still wins (and the cheater loses their deposit to that winner).
--     Self-report corroboration: fabricated offense can stay UNDER the rate
--     caps (e.g. 100 damage per victim over a fake 60s window), so a clean,
--     connected LOSER whose self-reported final_hp sits far above their
--     ledger-derived HP marks the match 'disputed' — the damage that "killed"
--     them was never received, so the winner's margin can't be trusted and no
--     automatic payout happens. The winner's own mismatch is ignored
--     (fabricated damage AGAINST the winner only hurt them; the win stands).
--     Only marks 'disputed' when no clean winner exists, no combat happened,
--     or corroboration fails.
--     p_force settles on timeout even if players never reported.
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
  v_live_n     int;
  v_dmg_total  bigint;
  v_winner     uuid;
  v_forfeited  uuid[];
  v_mismatch   uuid[];
  v_live       uuid[];
  v_disputed   boolean := false;
  v_meta       jsonb;
  -- Physical ceilings (buffer over real stats: sword ~40 dps, ~1.4 hits/s).
  c_max_dps      constant numeric := 50;   -- per attacker, total across all victims
  c_max_firerate constant numeric := 4;    -- hits per second, per attacker→victim pair
  -- A player is "disconnected" once its heartbeat lapses past this window.
  c_dc_grace     constant interval := interval '15 seconds';
  -- Self-report corroboration margin. Honest reports track the ledger closely
  -- (each client applies damage from the same attack events the attacker
  -- records); the slack absorbs grenade-splash variance and a dropped packet
  -- or two, while a fabricated lethal total overshoots it by design.
  c_hp_tolerance constant int := 25;
begin
  select status, started_at, max_players into v_status, v_started, v_maxp
  from matches where id = p_match_id for update;
  if v_status is null                     then raise exception 'match_not_found'; end if;
  if v_status in ('finished', 'disputed') then return; end if;

  -- Hard cap from match_config (per lobby size). Before it, hold open until
  -- everyone reports; after it (or on force), settle from the ledger now.
  v_deadline := coalesce(v_started, now()) + make_interval(secs => public.match_duration_seconds(v_maxp));

  -- Only WAIT on players who are still connected and haven't reported.
  -- Disconnected (stale heartbeat) players never block settlement.
  select count(*) filter (where final_hp is null and last_seen >= now() - c_dc_grace)
    into v_unreported
  from match_players where match_id = p_match_id;

  if not p_force and v_unreported > 0 and now() < v_deadline then
    return;
  end if;

  -- Early-report guard: before the deadline, everyone reporting is not by
  -- itself proof the match is over — a spoofed "match-over" broadcast can
  -- push every honest client to report seconds in. Only settle early when
  -- the ledger shows a lethal total against someone, or at most one player
  -- is still connected (walkover). Otherwise hold the match open; the
  -- deadline path settles it as usual.
  if not p_force and now() < v_deadline then
    select count(*) into v_live_n
    from match_players
    where match_id = p_match_id
      and not (final_hp is null and last_seen < now() - c_dc_grace);

    if v_live_n > 1 and not exists (
      select 1 from match_damage
      where match_id = p_match_id
      group by victim
      having sum(total_damage) >= 100
    ) then
      return;
    end if;
  end if;

  v_ended := now();
  v_secs  := greatest(5, extract(epoch from (v_ended - coalesce(v_started, v_ended))));

  select coalesce(sum(total_damage), 0) into v_dmg_total
  from match_damage where match_id = p_match_id;

  if v_dmg_total = 0 then
    -- No combat recorded. If everyone but one player has disconnected, that
    -- player wins by walkover (last one standing). Otherwise it's a genuine
    -- no-contest (e.g. nobody fought before the timer) → disputed.
    select coalesce(array_agg(user_id), '{}') into v_live
    from match_players
    where match_id = p_match_id
      and not (final_hp is null and last_seen < now() - c_dc_grace);

    if array_length(v_live, 1) = 1 then
      update matches
        set status = 'finished', winner_user_id = v_live[1], ended_at = v_ended,
            shadow_winner = v_live[1], forfeited_user_ids = '{}',
            shadow_meta = jsonb_build_object('reason', 'walkover', 'secs', v_secs)
        where id = p_match_id and status not in ('finished', 'disputed');
      if found then
        perform public.apply_match_result(p_match_id, v_live[1]);
      end if;
    else
      update matches
        set status = 'disputed', winner_user_id = NULL, ended_at = v_ended,
            shadow_winner = NULL,
            shadow_meta = jsonb_build_object('reason', 'no_combat', 'secs', v_secs)
        where id = p_match_id and status not in ('finished', 'disputed');
    end if;
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
    -- The match_id filter here is essential: without it every player in every
    -- match is ranked, and a concurrent match's player could be crowned winner
    -- of THIS match (winner_user_id is who the treasurer pays).
    select mp.user_id, mp.seat, mp.final_hp, mp.last_seen,
           greatest(0, 100 - coalesce(sum(v.dmg), 0))::int as hp
    from match_players mp
    left join valid v on v.victim = mp.user_id
    where mp.match_id = p_match_id
    group by mp.user_id, mp.seat, mp.final_hp, mp.last_seen
  ),
  ranked as (
    select h.user_id, h.hp, h.seat, h.final_hp,
           (f.attacker is not null) as is_flagged,
           -- Disconnected AND never reported → eliminated (a player who reported
           -- before leaving keeps their standing).
           (h.final_hp is null and h.last_seen < now() - c_dc_grace) as is_dc,
           row_number() over (
             -- Clean, connected players rank first; among them, highest HP then seat.
             order by (f.attacker is not null
                       or (h.final_hp is null and h.last_seen < now() - c_dc_grace)) asc,
                      h.hp desc, h.seat asc
           ) as rn
    from hp h
    left join flagged f on f.attacker = h.user_id
  )
  select
    (select user_id from ranked where rn = 1 and not is_flagged and not is_dc),
    (select coalesce(array_agg(user_id), '{}') from ranked where is_flagged),
    -- Corroboration: clean, connected players whose SELF-reported HP sits far
    -- above their ledger-derived HP — the damage the ledger says killed them
    -- was never actually received on their client.
    (select coalesce(array_agg(user_id), '{}') from ranked
      where not is_flagged and not is_dc
        and final_hp is not null
        and final_hp > hp + c_hp_tolerance),
    jsonb_build_object(
      'secs',  v_secs,
      'caps',  jsonb_build_object('dps', c_max_dps, 'firerate', c_max_firerate),
      'hp',    (select jsonb_agg(jsonb_build_object('user_id', user_id, 'hp', hp, 'seat', seat, 'flagged', is_flagged, 'dc', is_dc)
                                 order by hp desc, seat asc) from ranked),
      'flagged',      (select coalesce(jsonb_agg(attacker), '[]'::jsonb) from flagged),
      'disconnected', (select coalesce(jsonb_agg(user_id), '[]'::jsonb) from ranked where is_dc),
      'attacker_out', (select jsonb_object_agg(attacker::text, out_total) from attacker_totals)
    )
    into v_winner, v_forfeited, v_mismatch, v_meta;

  -- Disputed if no clean player can win (e.g. everyone flagged)…
  if v_winner is null then v_disputed := true; end if;

  -- …or if a LOSER's self-report contradicts the ledger damage against them:
  -- the winner's margin may rest on fabricated offense that stayed under the
  -- rate caps, so no automatic payout — hold for admin review. The winner is
  -- excluded: fabricated damage against them could only have hurt them.
  v_mismatch := array_remove(coalesce(v_mismatch, '{}'), v_winner);
  if coalesce(array_length(v_mismatch, 1), 0) > 0 then
    v_disputed := true;
    v_meta := v_meta || jsonb_build_object(
      'reason',   'ledger_mismatch',
      'mismatch', to_jsonb(v_mismatch),
      'hp_tolerance', c_hp_tolerance
    );
  end if;

  if v_disputed then
    update matches
      set status = 'disputed', winner_user_id = NULL, ended_at = v_ended,
          shadow_winner = NULL, shadow_meta = v_meta, forfeited_user_ids = v_forfeited
      where id = p_match_id and status not in ('finished', 'disputed');
  else
    update matches
      set status = 'finished', winner_user_id = v_winner, ended_at = v_ended,
          shadow_winner = v_winner, shadow_meta = v_meta, forfeited_user_ids = v_forfeited
      where id = p_match_id and status not in ('finished', 'disputed');
    if found then
      perform public.apply_match_result(p_match_id, v_winner);
    end if;
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- 8c. heartbeat / try_finalize — disconnect-aware settlement helpers.
--     Clients heartbeat while in an active match; a lapsed heartbeat marks a
--     player disconnected (finalize_match then stops waiting on them and excludes
--     them from winner selection). try_finalize lets a survivor nudge settlement.
-- ---------------------------------------------------------------------------
create or replace function public.heartbeat(p_match_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.match_players
  set last_seen = now()
  where match_id = p_match_id and user_id = auth.uid();
end;
$$;

create or replace function public.try_finalize(p_match_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then
    raise exception 'not_authenticated';
  end if;
  if not exists (
    select 1 from public.match_players
    where match_id = p_match_id and user_id = auth.uid()
  ) then
    raise exception 'not_a_participant';
  end if;
  perform public.finalize_match(p_match_id);
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
-- 10b. Combat-ledger write validation — reject impossible / out-of-context rows
--      at INSERT time so a tampered request fails immediately. Errors prefixed
--      'cheat_detected:' signal tampering (client kicks the player); 'stale:'
--      signals a benign late write (match already settled) the client ignores.
-- ---------------------------------------------------------------------------
create or replace function public.validate_match_damage()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_status text;
  v_dur_ms bigint;
  -- Generous single-hit ceiling; fine-grained DPS/fire-rate caps live in
  -- finalize_match. This only rejects blatantly impossible rows at write time.
  c_hard_per_hit constant int := 250;
begin
  select m.status, public.match_duration_seconds(m.max_players) * 1000
    into v_status, v_dur_ms
  from public.matches m where m.id = new.match_id;

  if v_status is null      then raise exception 'stale: match_not_found';  end if;
  if v_status <> 'active'   then raise exception 'stale: match_not_active'; end if;
  if not exists (select 1 from public.match_players
                 where match_id = new.match_id and user_id = new.attacker) then
    raise exception 'cheat_detected: attacker_not_in_match';
  end if;
  if not exists (select 1 from public.match_players
                 where match_id = new.match_id and user_id = new.victim) then
    raise exception 'cheat_detected: victim_not_in_match';
  end if;
  if new.first_t_ms < 0
     or new.last_t_ms < new.first_t_ms
     or new.last_t_ms > v_dur_ms + 30000 then
    raise exception 'cheat_detected: bad_timestamps';
  end if;
  if new.total_damage > 0 and new.hit_count < 1 then
    raise exception 'cheat_detected: damage_without_hits';
  end if;
  if new.total_damage > new.hit_count * c_hard_per_hit then
    raise exception 'cheat_detected: damage_exceeds_hit_ceiling';
  end if;
  return new;
end;
$$;

create or replace function public.validate_match_kills()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_status text;
  v_dur_ms bigint;
begin
  select m.status, public.match_duration_seconds(m.max_players) * 1000
    into v_status, v_dur_ms
  from public.matches m where m.id = new.match_id;

  if v_status is null      then raise exception 'stale: match_not_found';  end if;
  if v_status <> 'active'   then raise exception 'stale: match_not_active'; end if;
  if not exists (select 1 from public.match_players
                 where match_id = new.match_id and user_id = new.attacker) then
    raise exception 'cheat_detected: attacker_not_in_match';
  end if;
  if not exists (select 1 from public.match_players
                 where match_id = new.match_id and user_id = new.victim) then
    raise exception 'cheat_detected: victim_not_in_match';
  end if;
  if new.t_ms < 0 or new.t_ms > v_dur_ms + 30000 then
    raise exception 'cheat_detected: bad_timestamp';
  end if;
  return new;
end;
$$;

drop trigger if exists trg_validate_match_damage on public.match_damage;
create trigger trg_validate_match_damage
  before insert on public.match_damage
  for each row execute function public.validate_match_damage();

drop trigger if exists trg_validate_match_kills on public.match_kills;
create trigger trg_validate_match_kills
  before insert on public.match_kills
  for each row execute function public.validate_match_kills();

-- ---------------------------------------------------------------------------
-- 10c. report_integrity_signal — soft client telemetry (e.g. devtools opened).
--      Recorded for review only; never auto-forfeits (avoids false-positive bans).
-- ---------------------------------------------------------------------------
create or replace function public.report_integrity_signal(
  p_match_id uuid,
  p_kind     text,
  p_detail   jsonb default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then return; end if;
  perform public.enforce_rate_limit('integrity_signal', 20, interval '1 minute');
  insert into public.integrity_signals (user_id, match_id, kind, detail)
  values (v_uid, p_match_id, left(coalesce(p_kind, 'unknown'), 40), p_detail);
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
-- rate_limits and integrity_signals are touched only by SECURITY DEFINER
-- functions; RLS on with no policies blocks all direct client access.
alter table public.rate_limits       enable row level security;
alter table public.integrity_signals enable row level security;
alter table public.payouts           enable row level security;
alter table public.banned_users      enable row level security;
-- consumed_deposits is written/read only inside join_pvp_match (security
-- definer); RLS on with no policies blocks all direct client access.
alter table public.consumed_deposits enable row level security;
-- review_notes is written/read only by the f10admin edge function (service
-- role); RLS on with no policies blocks all direct client access.
alter table public.review_notes enable row level security;

-- Payouts: a player can read their own; inserts come only from the service role.
create policy "payouts_select_own"
on public.payouts for select to authenticated
using (winner_user_id = auth.uid());

-- Bans: a player can check their own ban status; only the service role writes.
create policy "banned_select_own"
on public.banned_users for select to authenticated
using (user_id = auth.uid());

drop trigger if exists trg_ban_forfeited on public.matches;
create trigger trg_ban_forfeited
  after update of forfeited_user_ids on public.matches
  for each row
  when (new.forfeited_user_ids is distinct from old.forfeited_user_ids
        and coalesce(array_length(new.forfeited_user_ids, 1), 0) > 0)
  execute function public.ban_forfeited();

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
grant select, update(display_name, skin_id) on public.profiles to authenticated;
grant select on public.matches      to authenticated;
grant select on public.match_players to authenticated;
grant select, insert on public.match_damage to authenticated;
grant select, insert on public.match_kills  to authenticated;
grant select on public.match_config to authenticated, anon;
grant select on public.payouts      to authenticated;
grant select on public.banned_users to authenticated;

grant execute on function public.sync_my_profile(text)                 to authenticated;
-- Name generation is server-side only (trigger, sync_my_profile, join RPC and
-- the column default all run as the function/table owner).
revoke all on function public.generate_unique_username() from public, anon, authenticated;
grant execute on function public.generate_unique_username() to service_role;
grant execute on function public.enforce_rate_limit(text, int, interval) to authenticated, service_role;
grant execute on function public.report_integrity_signal(uuid, text, jsonb) to authenticated;
grant execute on function public.is_banned(uuid)              to authenticated, service_role;
grant execute on function public.ban_user(uuid, text)         to service_role;
-- join_pvp_match is service-role only: the f10join edge function verifies the
-- deposit on-chain BEFORE calling it, so the browser cannot admit an unverified
-- deposit by calling the RPC directly.
revoke all on function public.join_pvp_match(uuid, smallint, text, text, text) from public, anon, authenticated;
grant execute on function public.join_pvp_match(uuid, smallint, text, text, text) to service_role;
grant execute on function public.leave_my_matches()                    to authenticated;
grant execute on function public.finish_match(uuid, int)               to authenticated;
grant execute on function public.heartbeat(uuid)                       to authenticated;
grant execute on function public.try_finalize(uuid)                    to authenticated;
grant execute on function public.claim_payout_slot(uuid)               to authenticated;
grant execute on function public.level_for_points(integer)             to authenticated;
grant execute on function public.get_leaderboard(integer, text)        to authenticated, anon;
grant execute on function public.get_holdings_wallets(integer)         to authenticated, anon;
grant execute on function public.match_duration_seconds(smallint)      to authenticated, service_role, anon;
grant execute on function public.pvp_capacity()                        to authenticated, anon;
grant execute on function public.pvp_capacity_cap()                    to authenticated, anon;

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
