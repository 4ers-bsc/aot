-- ============================================================================
-- seed_sample_data.sql — constant config values + sample rows to populate the
-- tables (so the ops dashboard, including the clickable match-detail modal, has
-- data to show).
--
-- HOW TO RUN: paste into the Supabase SQL editor, or
--   psql "$DATABASE_URL" -f supabase/seed_sample_data.sql
-- Run AFTER fresh_setup.sql (the schema must already exist). Every statement is
-- idempotent (ON CONFLICT DO NOTHING / upsert), so it is safe to re-run.
--
-- SECTION 1 is production-safe: the canonical constants the app depends on.
-- SECTION 2 is DEV/STAGING ONLY sample data — do NOT run it in production
-- (it inserts fake users, matches and deposits).
-- ============================================================================

-- ---------------------------------------------------------------------------
-- SECTION 1 — Constant configuration values (production-safe).
--   These are the single-row config tables the game reads. Upserted so the
--   values are pinned even after a wipe.
-- ---------------------------------------------------------------------------
insert into public.pvp_config (id, player_cap, entry_fee_tokens, winner_share_bps)
values (true, 150, 2500, 9000)
on conflict (id) do update
  set player_cap       = excluded.player_cap,
      entry_fee_tokens = excluded.entry_fee_tokens,
      winner_share_bps = excluded.winner_share_bps;

insert into public.match_config (max_players, duration_seconds) values
  (2,  300),   -- 5 min
  (5,  420),   -- 7 min
  (10, 600)    -- 10 min
on conflict (max_players) do update
  set duration_seconds = excluded.duration_seconds;

insert into public.maintain (id, value) values (true, 'n')
on conflict (id) do update set value = excluded.value;

-- ============================================================================
-- SECTION 2 — DEV/STAGING sample data.  DO NOT RUN IN PRODUCTION.
-- Wrapped in a DO block so a single missing prerequisite fails loudly rather
-- than half-populating. Comment out this whole section for a prod seed.
-- ============================================================================

-- Sample auth users. On a real Supabase, auth.users has many columns; only id
-- is strictly required for our foreign keys, the rest default/allow null. If a
-- GoTrue NOT NULL rejects a row, add the column here for your version.
insert into auth.users (id, email)
values
  ('aaaaaaaa-0000-4000-8000-000000000001', 'swiftblade@example.test'),
  ('aaaaaaaa-0000-4000-8000-000000000002', 'grimrookie@example.test'),
  ('aaaaaaaa-0000-4000-8000-000000000003', 'swiftbruiser@example.test'),
  ('aaaaaaaa-0000-4000-8000-000000000004', 'nightwarden@example.test')
on conflict (id) do nothing;

insert into public.profiles (user_id, display_name, wallet_address)
values
  ('aaaaaaaa-0000-4000-8000-000000000001', 'SwiftBlade-1133',   'ethereum:0x266e4811111111111111111111111111111a0001'),
  ('aaaaaaaa-0000-4000-8000-000000000002', 'GrimRookie-6506',   'ethereum:0x266e4822222222222222222222222222222a0002'),
  ('aaaaaaaa-0000-4000-8000-000000000003', 'SwiftBruiser-6608', 'ethereum:0x266e4833333333333333333333333333333a0003'),
  ('aaaaaaaa-0000-4000-8000-000000000004', 'NightWarden-2044',  'ethereum:0x266e4844444444444444444444444444444a0004')
on conflict (user_id) do nothing;

-- Matches: one PAID, one PENDING/stuck, one WAITING, one DISPUTED. Fixed UUIDs
-- so re-running is idempotent and the ids are easy to reference. Economics are
-- snapshotted (as join_pvp_match now does) so the detail modal shows them.
insert into public.matches
  (id, status, max_players, created_by, winner_user_id, created_at, started_at, ended_at,
   pot_tokens, payout_tx, payout_claimed_at, stats_applied,
   entry_fee_tokens, winner_share_bps, duration_seconds, economics_version)
values
  -- PAID (2-player, winner SwiftBruiser)
  ('cccccccc-0000-4000-8000-000000000010', 'finished', 2,
   'aaaaaaaa-0000-4000-8000-000000000003', 'aaaaaaaa-0000-4000-8000-000000000003',
   now() - interval '30 min', now() - interval '29 min', now() - interval '24 min',
   5000, '0x' || repeat('a1', 32), now() - interval '23 min', true,
   2500, 9000, 300, 1),
  -- PENDING / stuck (2-player, winner GrimRookie) — mirrors the stuck-payout case
  ('cccccccc-0000-4000-8000-000000000011', 'finished', 2,
   'aaaaaaaa-0000-4000-8000-000000000002', 'aaaaaaaa-0000-4000-8000-000000000002',
   now() - interval '12 min', now() - interval '11 min', now() - interval '6 min',
   5000, 'pending', now() - interval '5 min', true,
   2500, 9000, 300, 1),
  -- WAITING (2-player, one seat filled)
  ('cccccccc-0000-4000-8000-000000000012', 'waiting', 2,
   'aaaaaaaa-0000-4000-8000-000000000001', null,
   now() - interval '20 min', null, null,
   2500, null, null, false,
   2500, 9000, 300, 1),
  -- DISPUTED (2-player)
  ('cccccccc-0000-4000-8000-000000000013', 'disputed', 2,
   'aaaaaaaa-0000-4000-8000-000000000004', null,
   now() - interval '40 min', now() - interval '39 min', now() - interval '34 min',
   5000, null, null, false,
   2500, 9000, 300, 1)
on conflict (id) do nothing;

-- Seats + deposits. Lowercase hashes (as the app now normalises them).
insert into public.match_players
  (match_id, user_id, seat, display_name, joined_at, deposit_tx, deposit_wallet, final_hp, last_seen)
values
  -- PAID match seats
  ('cccccccc-0000-4000-8000-000000000010', 'aaaaaaaa-0000-4000-8000-000000000003', 1, 'SwiftBruiser-6608', now() - interval '30 min', '0x' || repeat('d1', 32), '0x266e4833333333333333333333333333333a0003', 100, now() - interval '24 min'),
  ('cccccccc-0000-4000-8000-000000000010', 'aaaaaaaa-0000-4000-8000-000000000001', 2, 'SwiftBlade-1133',   now() - interval '30 min', '0x' || repeat('d2', 32), '0x266e4811111111111111111111111111111a0001', 0,   now() - interval '24 min'),
  -- PENDING match seats
  ('cccccccc-0000-4000-8000-000000000011', 'aaaaaaaa-0000-4000-8000-000000000002', 1, 'GrimRookie-6506',   now() - interval '12 min', '0x' || repeat('d3', 32), '0x266e4822222222222222222222222222222a0002', 100, now() - interval '6 min'),
  ('cccccccc-0000-4000-8000-000000000011', 'aaaaaaaa-0000-4000-8000-000000000004', 2, 'NightWarden-2044',  now() - interval '12 min', '0x' || repeat('d4', 32), '0x266e4844444444444444444444444444444a0004', 0,   now() - interval '6 min'),
  -- WAITING match: one seat
  ('cccccccc-0000-4000-8000-000000000012', 'aaaaaaaa-0000-4000-8000-000000000001', 1, 'SwiftBlade-1133',   now() - interval '20 min', '0x' || repeat('d5', 32), '0x266e4811111111111111111111111111111a0001', null, now() - interval '18 min'),
  -- DISPUTED match seats
  ('cccccccc-0000-4000-8000-000000000013', 'aaaaaaaa-0000-4000-8000-000000000004', 1, 'NightWarden-2044',  now() - interval '40 min', '0x' || repeat('d6', 32), '0x266e4844444444444444444444444444444a0004', 40, now() - interval '34 min'),
  ('cccccccc-0000-4000-8000-000000000013', 'aaaaaaaa-0000-4000-8000-000000000002', 2, 'GrimRookie-6506',   now() - interval '40 min', '0x' || repeat('d7', 32), '0x266e4822222222222222222222222222222a0002', 35, now() - interval '34 min')
on conflict (match_id, user_id) do nothing;

-- Permanent single-use deposit ledger for every seat above.
insert into public.consumed_deposits (deposit_tx, user_id, match_id, consumed_at)
values
  ('0x' || repeat('d1', 32), 'aaaaaaaa-0000-4000-8000-000000000003', 'cccccccc-0000-4000-8000-000000000010', now() - interval '30 min'),
  ('0x' || repeat('d2', 32), 'aaaaaaaa-0000-4000-8000-000000000001', 'cccccccc-0000-4000-8000-000000000010', now() - interval '30 min'),
  ('0x' || repeat('d3', 32), 'aaaaaaaa-0000-4000-8000-000000000002', 'cccccccc-0000-4000-8000-000000000011', now() - interval '12 min'),
  ('0x' || repeat('d4', 32), 'aaaaaaaa-0000-4000-8000-000000000004', 'cccccccc-0000-4000-8000-000000000011', now() - interval '12 min'),
  ('0x' || repeat('d5', 32), 'aaaaaaaa-0000-4000-8000-000000000001', 'cccccccc-0000-4000-8000-000000000012', now() - interval '20 min'),
  ('0x' || repeat('d6', 32), 'aaaaaaaa-0000-4000-8000-000000000004', 'cccccccc-0000-4000-8000-000000000013', now() - interval '40 min'),
  ('0x' || repeat('d7', 32), 'aaaaaaaa-0000-4000-8000-000000000002', 'cccccccc-0000-4000-8000-000000000013', now() - interval '40 min')
on conflict (deposit_tx) do nothing;

-- Payout ledger row for the PAID match.
insert into public.payouts (match_id, winner_user_id, payout_tx, amount_raw, decimals, num_players, created_at)
values
  ('cccccccc-0000-4000-8000-000000000010', 'aaaaaaaa-0000-4000-8000-000000000003',
   '0x' || repeat('a1', 32), (4500::numeric * (10::numeric ^ 18)), 18, 2, now() - interval '23 min')
on conflict (match_id) do nothing;

-- A banned user, an integrity flag, and a review note so those tabs populate.
insert into public.banned_users (user_id, wallet, reason, created_at)
values ('aaaaaaaa-0000-4000-8000-000000000004', '0x266e4844444444444444444444444444444a0004', 'impossible_combat_output', now() - interval '33 min')
on conflict (user_id) do nothing;

-- These two tables have auto-increment PKs (no natural key to conflict on), so
-- guard with NOT EXISTS to stay idempotent across re-runs.
insert into public.integrity_signals (user_id, match_id, kind, detail, created_at)
select 'aaaaaaaa-0000-4000-8000-000000000004', 'cccccccc-0000-4000-8000-000000000013',
       'impossible_dps', '{"observed_dps": 999, "cap": 120}'::jsonb, now() - interval '35 min'
where not exists (
  select 1 from public.integrity_signals
  where match_id = 'cccccccc-0000-4000-8000-000000000013' and kind = 'impossible_dps'
);

insert into public.review_notes (subject_type, subject_id, note, action, author_id, created_at)
select 'match', 'cccccccc-0000-4000-8000-000000000013', 'Opened for review — DPS flag on NightWarden.', 'note',
       'aaaaaaaa-0000-4000-8000-000000000003', now() - interval '30 min'
where not exists (
  select 1 from public.review_notes
  where subject_id = 'cccccccc-0000-4000-8000-000000000013' and action = 'note'
);
