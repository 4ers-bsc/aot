-- ============================================================================
-- seed_sample_data.sql — canonical constant configuration values.
--
-- Populates ONLY the static config tables the game depends on (no sample
-- matches/users). Production-safe and idempotent — paste into the Supabase SQL
-- editor or run:  psql "$DATABASE_URL" -f supabase/seed_sample_data.sql
-- Run AFTER fresh_setup.sql (the schema must already exist).
--
-- Entry fee is 10,000 $FIGHT10 per player.
-- ============================================================================

-- Global PvP tunables (single-row). The entry-fee guard trigger blocks changes
-- while matches are live, so this upsert temporarily disables it to pin the
-- constant regardless of board state (safe: it is a fixed constant, not a
-- mid-flight change).
alter table public.pvp_config disable trigger pvp_config_guard;
insert into public.pvp_config (id, player_cap, entry_fee_tokens, winner_share_bps)
values (true, 150, 10000, 9000)
on conflict (id) do update
  set player_cap       = excluded.player_cap,
      entry_fee_tokens = excluded.entry_fee_tokens,
      winner_share_bps = excluded.winner_share_bps;
alter table public.pvp_config enable trigger pvp_config_guard;

-- Per-lobby match durations (single source of truth for the timer + settler).
insert into public.match_config (max_players, duration_seconds) values
  (2,  300),   -- 5 min
  (5,  420),   -- 7 min
  (10, 600)    -- 10 min
on conflict (max_players) do update
  set duration_seconds = excluded.duration_seconds;

-- Maintenance switch (single-row): 'n' = normal play, 'y' = under maintenance.
insert into public.maintain (id, value) values (true, 'n')
on conflict (id) do update set value = excluded.value;
