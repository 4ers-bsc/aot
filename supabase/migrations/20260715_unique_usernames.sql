-- ---------------------------------------------------------------------------
-- Migration: unique usernames.
--
-- Every player gets a unique display_name (case-insensitive):
--   * generate_unique_username() — random "AdjNoun-1234" handle, collision-
--     checked against profiles, used everywhere a name must be invented.
--   * New sign-ups no longer all start as 'Trench Rookie'; the trigger (and
--     the column default) hand out a generated unique name instead.
--   * sync_my_profile rejects a name another wallet already holds with
--     'username_taken', which the client shows as a friendly error.
--   * join_pvp_match never fails over a name: a requested name that is taken
--     by someone else is ignored and the player keeps their current one.
--   * Existing duplicates are backfilled (earliest holder keeps the name)
--     before the unique index is created.
--
-- Safe to run (and re-run) on an existing database. Run in the Supabase SQL
-- editor. Kept in sync with fresh_setup.sql §1/§2/§3/§4.
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

revoke all on function public.generate_unique_username() from public, anon, authenticated;
grant execute on function public.generate_unique_username() to service_role;

-- Backfill: rename duplicate holders (case-insensitive) so the unique index
-- can be created. The earliest profile keeps the contested name.
do $$
declare
  r record;
begin
  for r in
    select user_id
    from (
      select user_id,
             row_number() over (partition by lower(display_name)
                                order by created_at, user_id) as rn
      from public.profiles
    ) d
    where d.rn > 1
  loop
    update public.profiles
    set display_name = public.generate_unique_username()
    where user_id = r.user_id;
  end loop;
end;
$$;

-- The authoritative uniqueness guarantee: no two profiles may hold the same
-- name in any letter case, whatever code path wrote it.
create unique index if not exists idx_profiles_display_name_ci
  on public.profiles (lower(display_name));

-- A bare insert must not hand out the shared 'Trench Rookie' default anymore.
alter table public.profiles
  alter column display_name set default public.generate_unique_username();

-- Sign-up trigger: a requested metadata name that is already taken (or no
-- name at all) falls back to a generated unique one.
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

-- sync_my_profile: the player-facing save path. A name held by another wallet
-- is rejected with 'username_taken' so the profile dialog can say so.
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

-- join_pvp_match: same body as 20260709_consumed_deposits, with the profile
-- refresh made collision-safe — a requested name that belongs to another
-- wallet is dropped (the seat keeps the player's current name) so a join can
-- never fail over a username.
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
