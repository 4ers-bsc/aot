-- ============================================================================
-- Global concurrent-player cap (150) for PvP matches.
-- ----------------------------------------------------------------------------
-- Two pieces:
--   1. pvp_capacity() / pvp_capacity_cap() — public, RLS-free read of how many
--      wallets currently hold a live match seat vs. the cap. The client calls
--      this BEFORE charging the (non-refundable) entry fee, so a full server
--      is rejected without ever taking payment.
--   2. join_pvp_match — re-stated with the authoritative, server-side guard.
--      The client-side check above is advisory only; this is what actually
--      prevents overshoot, including under concurrent joins (via an advisory
--      lock scoped to the transaction).
-- ============================================================================

-- ---------------------------------------------------------------------------
-- pvp_capacity_cap — the cap lives in one place so the authoritative check
-- in join_pvp_match and the client's pre-payment check can't drift. Bump the
-- constant here to change the cap; no other code references it.
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

grant execute on function public.pvp_capacity()     to authenticated, anon;
grant execute on function public.pvp_capacity_cap() to authenticated, anon;

-- ---------------------------------------------------------------------------
-- join_pvp_match — re-stated in full with the capacity guard added after the
-- rejoin check (a player resuming their own existing seat is never blocked
-- by the cap) and before any new seat is assigned.
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

revoke all on function public.join_pvp_match(uuid, smallint, text, text, text) from public, anon, authenticated;
grant execute on function public.join_pvp_match(uuid, smallint, text, text, text) to service_role;
