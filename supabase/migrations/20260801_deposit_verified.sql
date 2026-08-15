-- ============================================================================
-- Verify-once-at-join: match_players.deposit_verified.
--
-- On Solana a deposit transaction can age past an RPC node's transaction-history
-- window during a long match (up to 10 min) plus the time to payout, so
-- re-verifying every deposit on-chain at payout time is slow and can spuriously
-- fail ("deposit not found on-chain"). Instead, f10join verifies each deposit
-- ONCE at join time — while the tx is still fresh — and sets this flag (service
-- role). f10treasurer / f10admin trust the flag at payout and skip the on-chain
-- re-verification, falling back to on-chain checks only for any legacy row that
-- was never flagged.
--
-- Security: clients hold only SELECT on match_players (RLS on, no UPDATE/INSERT
-- grant), so only the service role can set this — a browser can never flag its
-- own seat verified to conjure a payout.
--
-- Backfill: existing rows stay false so the payout path still verifies them
-- on-chain (unchanged behaviour for in-flight matches). New joins get the flag.
--
-- Safe to run (and re-run). Kept in sync with fresh_setup.sql.
-- ============================================================================

begin;

alter table public.match_players
  add column if not exists deposit_verified boolean not null default false;

commit;
