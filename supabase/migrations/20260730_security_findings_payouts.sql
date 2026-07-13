-- ============================================================================
-- Security findings — realtime session binding + payout hardening.
--
-- Addresses the payouts/realtime review (deltas vs. the previous round):
--
--   P0  Realtime sender identity was self-declared. The `match-<id>` broadcast
--       channel was PUBLIC, so anyone who guessed the id could subscribe,
--       observe positions, and inject `attack`/`state` events naming any player.
--       Bind the channel to authenticated match sessions: authorize the topic
--       through realtime.messages RLS so only a signed-in user who actually
--       holds a seat in that match may read or send on it. The client flips the
--       channel to `private: true` (see src/main.js).
--
--   P1  Match snapshot excluded the economic identity. entry_fee/winner_share
--       were frozen onto the match, but the TOKEN contract, CHAIN, and ESCROW
--       wallet a player deposited against were re-read live at payout time.
--       Snapshot them onto the match at creation so the payout path can refuse
--       to pay if the live token/chain/escrow no longer match what applied when
--       the players deposited (the full economic contract is now immutable).
--
--   P0  Payout nonce is now persisted alongside the hash. matches.payout_nonce
--       records the escrow nonce the payout was signed with, written together
--       with the real tx hash BEFORE the transfer is broadcast (see
--       f10treasurer). It lets a retry reconcile against the chain — a nonce
--       already consumed on-chain must never be re-sent (double-pay).
--
-- Safe to run (and re-run) on an existing database. Run in the Supabase SQL
-- editor as the role that owns the functions (postgres / supabase_admin).
-- The companion changes live in supabase/functions/{f10join,f10treasurer} and
-- src/main.js; the same statements are mirrored into fresh_setup.sql.
-- ============================================================================

begin;

-- ---------------------------------------------------------------------------
-- P1  Economic-identity snapshot + P0 payout nonce on matches.
--     Nullable: pre-existing matches keep NULL and the payout path treats a
--     missing snapshot as "nothing to enforce" (unchanged behaviour), while
--     every match opened from now on carries the full frozen contract.
-- ---------------------------------------------------------------------------
alter table public.matches
  add column if not exists token_address text,
  add column if not exists chain_id      int,
  add column if not exists escrow_wallet text,
  add column if not exists payout_nonce  int;

-- ---------------------------------------------------------------------------
-- P0  Realtime authorization for the private `match-<id>` topic.
--     A helper parses the match UUID out of the topic; the RLS policies then
--     admit only an authenticated user who holds a seat in that match. These
--     policies apply ONLY to PRIVATE channels — the public "online-players"
--     presence channel is unaffected.
-- ---------------------------------------------------------------------------
create or replace function public.match_id_from_topic(p_topic text)
returns uuid
language sql
immutable
set search_path = public
as $$
  -- Topics are `match-<uuid>`; anything else yields NULL so a non-match private
  -- topic is denied by the policies below rather than matching by accident.
  select case
    when p_topic ~* '^match-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      then substring(p_topic from 7)::uuid
    else null
  end;
$$;

grant execute on function public.match_id_from_topic(text) to authenticated;

-- Receiving broadcast/presence on a private match topic.
drop policy if exists "f10_match_realtime_read" on realtime.messages;
create policy "f10_match_realtime_read"
  on realtime.messages
  for select
  to authenticated
  using (
    exists (
      select 1
      from public.match_players mp
      where mp.match_id = public.match_id_from_topic(realtime.topic())
        and mp.user_id  = (select auth.uid())
    )
  );

-- Sending broadcast/presence on a private match topic.
drop policy if exists "f10_match_realtime_write" on realtime.messages;
create policy "f10_match_realtime_write"
  on realtime.messages
  for insert
  to authenticated
  with check (
    exists (
      select 1
      from public.match_players mp
      where mp.match_id = public.match_id_from_topic(realtime.topic())
        and mp.user_id  = (select auth.uid())
    )
  );

-- ---------------------------------------------------------------------------
-- P1  join_pvp_match: snapshot the economic identity (token / chain / escrow)
--     onto a NEWLY opened match, in addition to the fee/share/duration snapshot
--     already taken. Players joining an existing waiting match inherit the
--     snapshot captured at its creation. The three new params are supplied by
--     f10join from its verified deposit config and default to NULL so any
--     legacy 5-arg call still resolves. Body is otherwise byte-for-byte the
--     20260726_join_pvp_match_hardening.sql version.
-- ---------------------------------------------------------------------------
drop function if exists public.join_pvp_match(uuid, smallint, text, text, text);

create or replace function public.join_pvp_match(
  p_user_id        uuid,
  p_max_players    smallint default 2,
  p_deposit_tx     text     default null,
  p_display_name   text     default null,
  p_deposit_wallet text     default null,
  p_token_address  text     default null,
  p_chain_id       int      default null,
  p_escrow_wallet  text     default null
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
  v_deposit_tx   text;
  v_fee          int;
  v_share        int;
  v_dur          int;
  -- P1: economic-identity snapshot, normalised to a bare lowercase 0x address.
  v_token        text := lower(regexp_replace(coalesce(trim(p_token_address), ''), '^.*:', ''));
  v_escrow       text := lower(regexp_replace(coalesce(trim(p_escrow_wallet),  ''), '^.*:', ''));
  c_entry_fee    constant bigint := 2500;
begin
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

  if v_size not in (2, 5, 10) then
    raise exception 'invalid_max_players: must be 2, 5, or 10';
  end if;

  v_deposit_tx := lower(trim(p_deposit_tx));

  perform pg_advisory_xact_lock(hashtext('fight10_join_user:' || v_uid::text));

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

  if v_login_wallet is null
     or lower(regexp_replace(trim(v_login_wallet),  '^.*:', ''))
      <> lower(regexp_replace(trim(p_deposit_wallet), '^.*:', '')) then
    raise exception 'deposit_wallet_mismatch: deposit must come from your signed-in wallet';
  end if;

  select mp.match_id, mp.seat, m.status, m.max_players, m.started_at
  into   v_existing
  from   public.match_players mp
  join   public.matches m on m.id = mp.match_id
  where  mp.user_id = v_uid
    and  m.status in ('waiting', 'active')
  limit 1;

  if found and v_existing.status = 'active' then
    perform public.finalize_match(
      v_existing.match_id,
      v_existing.started_at is not null
        and now() >= v_existing.started_at
                     + make_interval(secs => public.match_duration_seconds(v_existing.max_players))
    );

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

  if exists (select 1 from public.consumed_deposits where lower(deposit_tx) = v_deposit_tx) then
    raise exception 'deposit_already_used: this deposit was already spent on a match entry';
  end if;

  perform pg_advisory_xact_lock(hashtext('fight10_pvp_capacity'));
  if (select count(*) from public.match_players mp
      join public.matches m on m.id = mp.match_id
      where m.status in ('waiting', 'active')) >= public.pvp_capacity_cap() then
    raise exception 'servers_full: % player cap reached, try again shortly', public.pvp_capacity_cap();
  end if;

  select m.id into v_match_id
  from   public.matches m
  where  m.status      = 'waiting'
    and  m.max_players = v_size
    and  (select count(*) from public.match_players mp where mp.match_id = m.id) < m.max_players
  order  by m.created_at
  for update of m skip locked
  limit  1;

  if found then
    select min(s) into v_seat
    from   generate_series(1, v_size) s
    where  s not in (select seat from public.match_players where match_id = v_match_id);

    insert into public.match_players (match_id, user_id, seat, display_name, deposit_tx, deposit_wallet)
    values (v_match_id, v_uid, v_seat, v_name, v_deposit_tx, trim(p_deposit_wallet));

    insert into public.consumed_deposits (deposit_tx, user_id, match_id)
    values (v_deposit_tx, v_uid, v_match_id);

    update public.matches
    set pot_tokens = pot_tokens + c_entry_fee
    where id = v_match_id;

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

  -- No waiting match — open a new one. Snapshot the economics AND the economic
  -- IDENTITY (token contract, chain, escrow wallet) that apply RIGHT NOW so the
  -- payout path verifies deposits and pays out against the exact contract the
  -- players deposited under, never a later config / redeploy.
  select entry_fee_tokens, winner_share_bps
  into   v_fee, v_share
  from   public.pvp_config
  limit  1;
  select duration_seconds into v_dur
  from   public.match_config
  where  max_players = v_size;

  insert into public.matches (
    status, max_players, created_by,
    entry_fee_tokens, winner_share_bps, duration_seconds,
    token_address, chain_id, escrow_wallet
  )
  values (
    'waiting', v_size, v_uid,
    coalesce(v_fee, 2500), coalesce(v_share, 9000), v_dur,
    nullif(v_token, ''), p_chain_id, nullif(v_escrow, '')
  )
  returning id into v_match_id;

  v_seat := 1;
  insert into public.match_players (match_id, user_id, seat, display_name, deposit_tx, deposit_wallet)
  values (v_match_id, v_uid, v_seat, v_name, v_deposit_tx, trim(p_deposit_wallet));

  insert into public.consumed_deposits (deposit_tx, user_id, match_id)
  values (v_deposit_tx, v_uid, v_match_id);

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

revoke all on function public.join_pvp_match(uuid, smallint, text, text, text, text, int, text) from public, anon, authenticated;
grant execute on function public.join_pvp_match(uuid, smallint, text, text, text, text, int, text) to service_role;

commit;
