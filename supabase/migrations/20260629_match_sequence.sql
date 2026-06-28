-- ============================================================================
-- Friendly sequential match number, starting at 1.
-- ----------------------------------------------------------------------------
-- The primary key stays the UUID (it's referenced everywhere and used for
-- realtime channels). This adds a separate auto-incrementing match_no for a
-- human-readable identifier (#1, #2, #3, …). Existing rows are backfilled.
--
-- Safe to run on an existing project (idempotent).
-- ============================================================================

do $$
begin
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'matches' and column_name = 'match_no'
  ) then
    alter table public.matches
      add column match_no bigint generated always as identity;
  end if;
end $$;

create unique index if not exists idx_matches_match_no on public.matches(match_no);
