-- ============================================================================
-- Migration: add match_players.deposit_verified
-- Run this on an existing deployment (fresh_setup.sql already includes it).
--
-- Deposits are now verified on-chain once, at deposit time, by the f10deposit
-- edge function, which sets deposit_verified = true via the service role. The
-- f10treasurer payout function trusts this flag instead of re-verifying every
-- deposit on-chain at payout time.
-- ============================================================================

alter table public.match_players
  add column if not exists deposit_verified boolean not null default false;

-- Existing rows default to false. f10treasurer falls back to on-chain
-- verification (and back-fills the flag) for any deposit that is not yet
-- verified, so matches that were already in flight when this column was added
-- still pay out correctly. Optionally, you may back-fill known-good historical
-- deposits manually, e.g.:
--
--   update public.match_players mp
--   set deposit_verified = true
--   from public.matches m
--   where m.id = mp.match_id
--     and m.payout_tx is not null            -- already paid out → deposits were valid
--     and mp.deposit_tx is not null;

-- NOTE: do NOT grant update(deposit_verified) to authenticated. The flag must
-- only ever be set by the service role (f10deposit) after on-chain verification.
