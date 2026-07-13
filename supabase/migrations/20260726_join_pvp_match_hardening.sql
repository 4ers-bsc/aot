-- ---------------------------------------------------------------------------
-- join_pvp_match hardening. Redefines the canonical join RPC (last defined in
-- 20260717_robinhood_chain.sql) with three review fixes; the body is otherwise
-- byte-for-byte the same:
--
--   #8  Concurrent join race. The "already in a live match?" check ran before
--       the global capacity lock, so two requests from the SAME user could both
--       pass the membership lookup and take two seats. Take a per-user advisory
--       xact lock at the very top so a user's concurrent joins serialise and the
--       membership check is done while holding it.
--   #7  Case-insensitive deposit replay. Normalise the deposit hash to lowercase
--       before it is checked against the consumed-deposit ledger and stored, so
--       a re-cased hash can't slip past as a distinct deposit (matches the
--       functional unique indexes added in 20260725).
--   #4  Immutable match economics. When OPENING a new match, snapshot the entry
--       fee, winner share and duration onto the row so the payout path verifies
--       against the values that applied when players deposited. Players joining
--       an existing waiting match inherit the snapshot taken at its creation.
--
-- Safe to run (and re-run) on an existing database. Depends on the columns +
-- indexes added in 20260725_privilege_and_economics_hardening.sql.
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
  -- #7: EVM tx hashes are case-insensitive — normalise once so the ledger check
  -- and the stored value are always lowercase (see the functional unique
  -- indexes in 20260725_privilege_and_economics_hardening.sql).
  v_deposit_tx   text;
  -- #4: economics snapshot captured when a NEW match is opened.
  v_fee          int;
  v_share        int;
  v_dur          int;
  -- WHOLE tokens, not raw units: 2500 × 10^18 raw (18-decimal ERC-20) would
  -- overflow bigint. Display layers know pot_tokens needs no decimals shift.
  c_entry_fee    constant bigint := 2500;
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

  -- #7: canonical lowercase deposit hash used for every read + write below.
  v_deposit_tx := lower(trim(p_deposit_tx));

  -- #8: serialise this user's concurrent joins. Two simultaneous requests from
  -- the same wallet could otherwise both pass the "already in a live match?"
  -- lookup below and take two seats. The lock is per-user (keyed on the uid),
  -- held to end of transaction, and released automatically on commit/rollback —
  -- it does not block other users. Taken BEFORE the membership check so that
  -- check is done while holding it.
  perform pg_advisory_xact_lock(hashtext('fight10_join_user:' || v_uid::text));

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
  -- (e.g. "ethereum:0x…"), so compare only the trailing address segment —
  -- LOWERCASED, because the same Ethereum address can arrive checksummed
  -- (EIP-55 mixed case) or all-lowercase.
  if v_login_wallet is null
     or lower(regexp_replace(trim(v_login_wallet),  '^.*:', ''))
      <> lower(regexp_replace(trim(p_deposit_wallet), '^.*:', '')) then
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
  -- #7: compared case-insensitively against the normalised hash.
  if exists (select 1 from public.consumed_deposits where lower(deposit_tx) = v_deposit_tx) then
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
    values (v_match_id, v_uid, v_seat, v_name, v_deposit_tx, trim(p_deposit_wallet));

    insert into public.consumed_deposits (deposit_tx, user_id, match_id)
    values (v_deposit_tx, v_uid, v_match_id);

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

  -- No waiting match found — open a new one. #4: snapshot the economics that
  -- apply RIGHT NOW onto the match so the payout path always verifies deposits
  -- and computes the prize against these frozen values, never a later
  -- pvp_config / match_config edit. Read defensively so a missing config row
  -- can never NULL out the pot bookkeeping.
  select entry_fee_tokens, winner_share_bps
  into   v_fee, v_share
  from   public.pvp_config
  limit  1;
  select duration_seconds into v_dur
  from   public.match_config
  where  max_players = v_size;

  insert into public.matches (
    status, max_players, created_by,
    entry_fee_tokens, winner_share_bps, duration_seconds
  )
  values (
    'waiting', v_size, v_uid,
    coalesce(v_fee, 2500), coalesce(v_share, 9000), v_dur
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

revoke all on function public.join_pvp_match(uuid, smallint, text, text, text) from public, anon, authenticated;
grant execute on function public.join_pvp_match(uuid, smallint, text, text, text) to service_role;
