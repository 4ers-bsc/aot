-- ============================================================================
-- Security & reliability hardening — privileges, immutable economics, escrow
-- serialization, and case-insensitive deposit replay protection.
--
-- Addresses the database-boundary review:
--   #2  SECURITY DEFINER admin functions were granted to service_role but never
--       revoked from PostgreSQL's default PUBLIC execute — an authenticated user
--       could reach them via PostgREST RPC. Revoke PUBLIC/anon/authenticated on
--       every privileged definer function, lock down DEFAULT PRIVILEGES so a
--       future function can't re-introduce the hole, and add a caller assertion
--       to admin_resolve_dispute (the one privileged entrypoint with no internal
--       callers) as defense in depth.
--   #4  Match economics (entry fee, winner share, duration) were re-read live
--       from pvp_config at payout time, so an admin config change could break an
--       already-settled match's claim. Snapshot them onto the match so payouts
--       verify against the values that applied when players deposited.
--   #6  Every payout edge invocation builds its own escrow wallet, so two
--       concurrent payouts could grab the same nonce and invalidate each other.
--       Add a durable single-flight lock the payout functions hold across nonce
--       assignment + broadcast.
--   #7  Deposit tx hashes were stored with their original casing but compared
--       exact-match, so the same tx in different case could pass as two distinct
--       deposits. Add functional unique indexes on lower(deposit_tx).
--
-- Safe to run (and re-run) on an existing database. Run in the Supabase SQL
-- editor as the same role that owns the functions (postgres / supabase_admin).
-- The companion migration 20260726_join_pvp_match_hardening.sql redefines
-- join_pvp_match to populate the snapshot columns and normalise deposit hashes.
-- ============================================================================

begin;

-- ---------------------------------------------------------------------------
-- #2  Revoke inherited PUBLIC execute on every privileged SECURITY DEFINER
--     function, then re-grant only to service_role. These run as their owner,
--     so revoking PUBLIC does NOT break the internal call chains that invoke
--     them from other definer functions (those calls execute as the owner, not
--     as the original caller's role).
-- ---------------------------------------------------------------------------
revoke all on function public.admin_resolve_dispute(uuid, uuid) from public, anon, authenticated;
revoke all on function public.ban_user(uuid, text)             from public, anon, authenticated;
revoke all on function public.apply_match_result(uuid, uuid)   from public, anon, authenticated;
revoke all on function public.finalize_match(uuid, boolean)    from public, anon, authenticated;
revoke all on function public.close_stale_matches()            from public, anon, authenticated;

grant execute on function public.admin_resolve_dispute(uuid, uuid) to service_role;
grant execute on function public.ban_user(uuid, text)             to service_role;
grant execute on function public.apply_match_result(uuid, uuid)   to service_role;
grant execute on function public.finalize_match(uuid, boolean)    to service_role;
grant execute on function public.close_stale_matches()            to service_role;

-- Stop the leak at the source: never auto-grant EXECUTE to PUBLIC on functions
-- created FROM NOW ON in the public schema. Must run as the role that creates
-- subsequent functions (postgres / supabase_admin) to take effect for them.
alter default privileges in schema public revoke execute on functions from public;

-- ---------------------------------------------------------------------------
-- #2 (defense in depth)  Caller assertion on admin_resolve_dispute. This is the
--     only privileged entrypoint with NO internal callers, so it is safe to
--     require the service_role JWT here without breaking a definer call chain.
--     (ban_user / apply_match_result / finalize_match / close_stale_matches are
--     all called internally from authenticated-reachable definer functions, so
--     they rely solely on the revoke above — an assertion would break them.)
--     Body is kept byte-for-byte in sync with 20260724_security_reliability_
--     hardening.sql, with only the guard prepended.
-- ---------------------------------------------------------------------------
create or replace function public.admin_resolve_dispute(p_match_id uuid, p_winner_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_status text;
  v_role   text;
begin
  -- Only the service role may resolve a dispute. When there are no request JWT
  -- claims (direct SQL / cron), current_setting returns NULL and we allow it;
  -- any HTTP caller whose role is not service_role is rejected. Combined with
  -- the revoke above (which already blocks anon/authenticated from reaching the
  -- function at all) this is belt-and-suspenders against an accidental re-grant.
  v_role := nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role';
  if v_role is not null and v_role <> 'service_role' then
    raise exception 'forbidden: admin only';
  end if;

  select status into v_status from matches where id = p_match_id for update;
  if v_status is null then
    raise exception 'match_not_found';
  end if;
  if v_status <> 'disputed' then
    raise exception 'not_disputed:%', v_status;
  end if;
  if not exists (
    select 1 from match_players where match_id = p_match_id and user_id = p_winner_id
  ) then
    raise exception 'winner_not_participant';
  end if;

  update matches
  set status = 'finished', winner_user_id = p_winner_id,
      shadow_winner = p_winner_id, ended_at = now()
  where id = p_match_id and status = 'disputed';

  -- Runs in the same transaction; if it raises, the status flip rolls back too.
  perform public.apply_match_result(p_match_id, p_winner_id);
end;
$$;
revoke all on function public.admin_resolve_dispute(uuid, uuid) from public, anon, authenticated;
grant execute on function public.admin_resolve_dispute(uuid, uuid) to service_role;

-- ---------------------------------------------------------------------------
-- #7  Case-insensitive deposit replay protection. EVM tx hashes are
--     case-insensitive (0xABC… and 0xabc… are the same tx), so a plain unique
--     constraint on the raw string can be bypassed by re-casing a hash. Add
--     functional unique indexes on lower(deposit_tx) alongside the existing
--     exact-match uniqueness. The companion migration lowercases the value at
--     write time so both agree; these indexes are the hard DB-level guarantee.
-- ---------------------------------------------------------------------------
create unique index if not exists consumed_deposits_tx_lower_unique
  on public.consumed_deposits (lower(deposit_tx));

create unique index if not exists match_players_deposit_tx_lower_unique
  on public.match_players (lower(deposit_tx))
  where deposit_tx is not null;

-- ---------------------------------------------------------------------------
-- #4  Immutable match economics. Snapshot the mutable tunables (entry fee,
--     winner share, match duration) onto each match at creation so the payout
--     path verifies deposits and computes the prize against the values that
--     applied when players actually deposited — not whatever pvp_config /
--     match_config currently hold. Nullable + backfilled: pre-existing matches
--     have no snapshot and the payout functions fall back to live config for
--     them, so this is safe to add to a live table.
-- ---------------------------------------------------------------------------
alter table public.matches
  add column if not exists entry_fee_tokens  int,
  add column if not exists winner_share_bps  int,
  add column if not exists duration_seconds  int,
  add column if not exists economics_version int not null default 1;

-- Backfill still-live (waiting/active) matches from current config so an
-- in-flight match created just before this migration also gets a snapshot.
-- Finished matches are intentionally left untouched — their payout already
-- resolved (or will resolve) against the config that was live at settle time.
update public.matches m
set entry_fee_tokens = coalesce(m.entry_fee_tokens, c.entry_fee_tokens),
    winner_share_bps = coalesce(m.winner_share_bps, c.winner_share_bps),
    duration_seconds = coalesce(m.duration_seconds, mc.duration_seconds)
from (select entry_fee_tokens, winner_share_bps from public.pvp_config limit 1) c
left join public.match_config mc on true
where m.status in ('waiting', 'active')
  and mc.max_players = m.max_players;

-- ---------------------------------------------------------------------------
-- #6  Durable escrow single-flight lock. A single row whose holder + expiry the
--     payout edge functions claim before assigning a nonce and broadcasting,
--     then release the instant the tx is in the mempool. Serialises payouts
--     across DIFFERENT matches that share the one escrow wallet, so two
--     concurrent payouts can't read the same pending nonce and collide. The TTL
--     lets a crashed holder's lock self-expire instead of wedging payouts.
-- ---------------------------------------------------------------------------
create table if not exists public.escrow_payout_lock (
  id           boolean primary key default true check (id), -- single-row guard
  holder       text,
  locked_at    timestamptz,
  locked_until timestamptz
);
insert into public.escrow_payout_lock (id) values (true) on conflict (id) do nothing;

-- Claim the lock for p_holder if it is free or its TTL has expired. One UPDATE,
-- so two concurrent claimers can never both succeed. Returns true on acquire.
create or replace function public.begin_escrow_payout(p_holder text, p_ttl_seconds int default 60)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_holder is null or length(trim(p_holder)) = 0 then
    raise exception 'holder_required';
  end if;
  update public.escrow_payout_lock
  set holder       = p_holder,
      locked_at    = now(),
      locked_until = now() + make_interval(secs => greatest(5, p_ttl_seconds))
  where id = true
    and (locked_until is null or locked_until < now());
  return found;
end;
$$;

-- Release the lock, but only if we still hold it (never stomp a holder that
-- took over after our TTL expired).
create or replace function public.end_escrow_payout(p_holder text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.escrow_payout_lock
  set holder = null, locked_at = null, locked_until = null
  where id = true and holder = p_holder;
end;
$$;

revoke all on function public.begin_escrow_payout(text, int) from public, anon, authenticated;
revoke all on function public.end_escrow_payout(text)        from public, anon, authenticated;
grant execute on function public.begin_escrow_payout(text, int) to service_role;
grant execute on function public.end_escrow_payout(text)        to service_role;

-- Client access to the lock table runs only through the service role (edge
-- functions); RLS on with no policies blocks all direct anon/authenticated use.
alter table public.escrow_payout_lock enable row level security;

commit;
