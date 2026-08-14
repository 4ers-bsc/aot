-- ============================================================================
-- Migration: Robinhood Chain (Ethereum) → Solana.
--
-- The game now runs on Solana (mainnet-beta). $FIGHT10 is an SPL token and
-- wallets/mints/signatures are base58. This reverses the case-folding the
-- Ethereum migration (20260717 / 20260725 / 20260730) introduced and adds the
-- payout blockhash the Solana payout path needs. Four consequences:
--
--   1. Wallet + deposit comparisons must be CASE-SENSITIVE again. Base58 Solana
--      keys and transaction signatures are case-sensitive (unlike EIP-55
--      Ethereum addresses and case-insensitive EVM tx hashes), so every
--      lower() the EVM build added around wallet/deposit comparison is REMOVED:
--        • join_pvp_match's login-wallet == deposit-wallet check
--        • the deposit_tx replay-ledger check + the value it stores
--        • the token/escrow economic-identity snapshot
--
--   2. The functional unique indexes on lower(deposit_tx) are DROPPED. They were
--      added for case-insensitive EVM hashes; on base58 signatures the exact
--      unique constraints already present (consumed_deposits.deposit_tx PRIMARY
--      KEY, match_players unique(deposit_tx)) are the correct guard.
--
--   3. Payouts double-spend protection is signature+blockhash based, not nonce
--      based. matches.payout_blockhash records the recent blockhash a payout was
--      signed with (written with the signature BEFORE broadcast, see
--      f10treasurer/f10admin). A retry that finds the signature un-landed only
--      re-sends once that blockhash has EXPIRED — an expired tx can never
--      commit, so a resend can't double-pay. matches.payout_nonce is left in
--      place (unused) for backward compatibility.
--
--   4. payouts.decimals default flips 18 → 9 (SPL $FIGHT10 uses 9 decimals).
--      Existing rows keep their stored decimals; only new rows default to 9.
--
-- pot_tokens stays in WHOLE tokens (unchanged from the EVM build) — no raw-unit
-- rescale is needed. Safe to run (and re-run) on an existing database. Run in
-- the Supabase SQL editor as the role that owns the functions. Kept in sync with
-- fresh_setup.sql.
-- ============================================================================

begin;

-- 3. Blockhash the payout was signed with (Solana's replace for payout_nonce).
alter table public.matches
  add column if not exists payout_blockhash text;

-- 2. Drop the case-insensitive (lower()) deposit indexes — base58 signatures are
--    case-sensitive, and the exact unique constraints remain the guard.
drop index if exists public.consumed_deposits_tx_lower_unique;
drop index if exists public.match_players_deposit_tx_lower_unique;

-- 4. New payout rows default to 9 decimals (SPL). Existing rows keep their value.
alter table public.payouts alter column decimals set default 9;

-- 1. join_pvp_match — case-sensitive base58 comparisons (no lower()). Body is
--    otherwise identical to 20260730_security_findings_payouts.sql.
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
  -- P1: economic-identity snapshot, normalised to a bare base58 address. Base58
  -- is CASE-SENSITIVE — no lower() (see the Solana migration).
  v_token        text := regexp_replace(coalesce(trim(p_token_address), ''), '^.*:', '');
  v_escrow       text := regexp_replace(coalesce(trim(p_escrow_wallet),  ''), '^.*:', '');
  c_entry_fee    constant bigint := 10000;
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

  -- Base58 signatures are CASE-SENSITIVE — store/compare the exact value.
  v_deposit_tx := trim(p_deposit_tx);

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

  -- One wallet per player: the wallet that signs the deposit MUST equal the
  -- wallet the player signed in with. Both may carry a "solana:" prefix; compare
  -- only the trailing base58 segment, CASE-SENSITIVELY (no lower()).
  if v_login_wallet is null
     or regexp_replace(trim(v_login_wallet),  '^.*:', '')
      <> regexp_replace(trim(p_deposit_wallet), '^.*:', '') then
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

  -- Deposit signatures are single-use, permanently. Exact match (case-sensitive).
  if exists (select 1 from public.consumed_deposits where deposit_tx = v_deposit_tx) then
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
  -- IDENTITY (token mint, cluster, escrow wallet) that apply RIGHT NOW so the
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
    coalesce(v_fee, 10000), coalesce(v_share, 9000), v_dur,
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
