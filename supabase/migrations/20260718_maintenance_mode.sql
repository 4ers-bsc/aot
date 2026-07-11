-- ============================================================================
-- maintain — global maintenance-mode switch.
-- ----------------------------------------------------------------------------
-- A single-row table the client reads at boot. When its `value` is 'y' the app
-- shows an "under maintenance" screen and nothing else loads or works; any other
-- value (default 'n') is normal operation.
--
-- Flip it from the Supabase dashboard / SQL editor:
--   update public.maintain set value = 'y';   -- turn maintenance ON
--   update public.maintain set value = 'n';   -- turn maintenance OFF
--
-- The `id boolean primary key default true check (id)` column pins the table to
-- exactly one row, so `select value from maintain limit 1` is always the switch.
-- World-readable (like match_config) so the anon client can read it before login;
-- writes are service-role only (no write policy), so a browser can't toggle it.
--
-- Safe to run on an existing project (idempotent).
-- ============================================================================

create table if not exists public.maintain (
  id    boolean primary key default true check (id), -- single-row guard
  value text not null default 'n'
);

insert into public.maintain (id, value) values (true, 'n')
on conflict (id) do nothing;

-- World-readable (non-sensitive; the client must read it before sign-in).
alter table public.maintain enable row level security;
drop policy if exists "maintain_select_all" on public.maintain;
create policy "maintain_select_all"
  on public.maintain for select to authenticated, anon using (true);
grant select on public.maintain to authenticated, anon;
