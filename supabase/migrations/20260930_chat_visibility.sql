-- ---------------------------------------------------------------------------
-- Migration: ops-dashboard switch to show / hide the home-screen chat.
--
-- Adds chat_config, a single-row settings table for the broadcast chat:
--   * visible — when false the chat box is hidden for EVERY visitor (players and
--     host alike). Flipped from the ops dashboard (#admin → Community → Chat &
--     votes → Chat visibility) through the admin-gated f10admin `set_config`
--     action, which also records a review note. Defaults to true, so an existing
--     deployment keeps showing the chat until an operator turns it off.
--
-- Same shape + access model as `maintain`: the `id boolean primary key default
-- true check (id)` column pins the table to one row; it is world-readable (the
-- home screen reads it before sign-in); there is no write policy, so only the
-- service role (f10admin) can change it. This is a DISPLAY switch, not access
-- control — chat_messages / chat_poll stay publicly readable either way.
--
-- chat_config joins the supabase_realtime publication so an open page hides /
-- shows the chat the moment the operator flips the switch, with no reload.
--
-- It is also added to the dashboard's wipe guard: "Wipe table" refuses it and
-- "Wipe ALL" preserves it, like the other config tables. admin_truncate_all's
-- `preserved` list is now derived from admin_is_protected_table instead of
-- being a second hand-maintained copy of the table names.
--
-- Safe to run (and re-run) on an existing database. Run in the Supabase SQL
-- editor. Kept in sync with fresh_setup.sql §13 (Home chat) and §17 (wipe guard).
-- ---------------------------------------------------------------------------

begin;

-- ── Visibility switch ───────────────────────────────────────────────────────
create table if not exists public.chat_config (
  id      boolean primary key default true check (id), -- single-row guard
  visible boolean not null default true
);

insert into public.chat_config (id, visible) values (true, true)
on conflict (id) do nothing;

-- World-readable (the client must read it before sign-in). No write policy:
-- only the service role (f10admin) can flip it.
alter table public.chat_config enable row level security;
drop policy if exists "chat_config_select_all" on public.chat_config;
create policy "chat_config_select_all"
  on public.chat_config for select to authenticated, anon using (true);
grant select on public.chat_config to authenticated, anon;

-- ── Realtime ────────────────────────────────────────────────────────────────
do $$
begin
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    create publication supabase_realtime;
  end if;

  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'chat_config'
  ) then
    alter publication supabase_realtime add table public.chat_config;
  end if;
end
$$;

-- ── Wipe guard ──────────────────────────────────────────────────────────────
create or replace function public.admin_is_protected_table(p_table text)
returns boolean
language sql
immutable
set search_path = public
as $$
  -- Constant configuration + static single-row locks: never wipeable.
  select p_table in ('pvp_config', 'match_config', 'maintain', 'escrow_payout_lock', 'chat_config');
$$;

-- Wipe every table EXCEPT the protected config/static ones, which are preserved.
-- Unchanged from 20260727 apart from deriving `preserved` from the guard above.
create or replace function public.admin_truncate_all()
returns jsonb
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  v_list      text;
  v_names     text[];
  v_preserved text[];
  v_total     bigint := 0;
  v_count     bigint;
begin
  select coalesce(array_agg(table_name order by table_name), '{}')
    into v_preserved
  from information_schema.tables
  where table_schema = 'public' and table_type = 'BASE TABLE'
    and public.admin_is_protected_table(table_name);

  select array_agg(table_name order by table_name)
    into v_names
  from information_schema.tables
  where table_schema = 'public' and table_type = 'BASE TABLE'
    and not public.admin_is_protected_table(table_name);

  if v_names is null or array_length(v_names, 1) is null then
    return jsonb_build_object('tables', '[]'::jsonb, 'rows', 0, 'preserved', to_jsonb(v_preserved));
  end if;

  foreach v_list in array v_names loop
    execute format('select count(*) from public.%I', v_list) into v_count;
    v_total := v_total + v_count;
  end loop;

  select string_agg(format('public.%I', table_name), ', ')
    into v_list
  from information_schema.tables
  where table_schema = 'public' and table_type = 'BASE TABLE'
    and not public.admin_is_protected_table(table_name);
  execute 'truncate table ' || v_list || ' restart identity cascade';

  return jsonb_build_object(
    'tables', to_jsonb(v_names),
    'rows', v_total,
    'preserved', to_jsonb(v_preserved)
  );
end;
$$;

revoke all on function public.admin_is_protected_table(text) from public, anon, authenticated;
revoke all on function public.admin_truncate_all()           from public, anon, authenticated;
grant execute on function public.admin_is_protected_table(text) to service_role;
grant execute on function public.admin_truncate_all()           to service_role;

commit;
