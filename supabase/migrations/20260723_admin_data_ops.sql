-- ============================================================================
-- admin data ops — export (snapshot) + wipe (truncate) helpers for the ops
-- dashboard's "Database" tab (surfaced via the f10admin edge function).
-- ----------------------------------------------------------------------------
-- These are POWERFUL, admin-only maintenance tools:
--   • admin_export_table / admin_snapshot — read every row of one / all public
--     tables as JSON, for a downloadable backup snapshot.
--   • admin_truncate_table / admin_truncate_all — DELETE EVERY ROW of one / all
--     public tables (TRUNCATE … RESTART IDENTITY CASCADE). Irreversible.
--
-- All four are security definer and granted to service_role ONLY — the browser
-- never calls them directly, it goes through the admin-gated f10admin function,
-- which additionally requires a typed confirmation before any wipe. Table names
-- are validated against information_schema and quoted with format(%I), so a
-- caller can't reach outside public or inject SQL.
--
-- Safe to run on an existing project (idempotent).
-- ============================================================================

-- Guard: the given name is a real base table in the public schema. Raises
-- 'unknown_table' otherwise so callers never operate on an arbitrary identifier.
create or replace function public.admin_assert_public_table(p_table text)
returns void
language plpgsql
stable
security definer
set search_path = public, pg_catalog
as $$
begin
  if not exists (
    select 1 from information_schema.tables
    where table_schema = 'public'
      and table_name = p_table
      and table_type = 'BASE TABLE'
  ) then
    raise exception 'unknown_table: %', p_table;
  end if;
end;
$$;

-- Every row of one public table as a JSON array (service-role read; used for
-- the per-table download).
create or replace function public.admin_export_table(p_table text)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_catalog
as $$
declare
  v_rows jsonb;
begin
  perform public.admin_assert_public_table(p_table);
  execute format('select coalesce(jsonb_agg(t), ''[]''::jsonb) from public.%I t', p_table)
    into v_rows;
  return v_rows;
end;
$$;

-- Full snapshot: { table_name -> [rows…] } for every public base table.
create or replace function public.admin_snapshot()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_catalog
as $$
declare
  v_result jsonb := '{}'::jsonb;
  v_rows   jsonb;
  r        record;
begin
  for r in
    select table_name from information_schema.tables
    where table_schema = 'public' and table_type = 'BASE TABLE'
    order by table_name
  loop
    execute format('select coalesce(jsonb_agg(t), ''[]''::jsonb) from public.%I t', r.table_name)
      into v_rows;
    v_result := v_result || jsonb_build_object(r.table_name, v_rows);
  end loop;
  return v_result;
end;
$$;

-- Wipe ONE public table. Returns how many rows were removed. RESTART IDENTITY
-- resets serial counters. Deliberately NO CASCADE: if another table's foreign
-- key points at this one, the wipe is REFUSED with the list of referencing
-- tables — a CASCADE here would silently empty those children too (e.g. wiping
-- `matches` would also blow away the `consumed_deposits` replay ledger). Wipe
-- the children first, or use admin_truncate_all() for a full reset. IRREVERSIBLE.
create or replace function public.admin_truncate_table(p_table text)
returns bigint
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  v_count bigint;
  v_refs  text;
begin
  perform public.admin_assert_public_table(p_table);

  select string_agg(distinct c.conrelid::regclass::text, ', ' order by c.conrelid::regclass::text)
    into v_refs
  from pg_constraint c
  where c.contype = 'f'
    and c.confrelid = ('public.' || quote_ident(p_table))::regclass
    and c.conrelid <> c.confrelid;          -- ignore self-references
  if v_refs is not null then
    raise exception 'has_references: % is referenced by: % — wipe those first, or use "Wipe ALL".', p_table, v_refs;
  end if;

  execute format('select count(*) from public.%I', p_table) into v_count;
  execute format('truncate table public.%I restart identity', p_table);
  return v_count;
end;
$$;

-- Wipe EVERY public table in a single statement (so mutual FKs don't need a
-- particular order). Returns the list of tables emptied and the total row count
-- removed. IRREVERSIBLE — this empties the entire application schema.
create or replace function public.admin_truncate_all()
returns jsonb
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  v_list   text;
  v_names  text[];
  v_total  bigint := 0;
  v_count  bigint;
  r        record;
begin
  select array_agg(table_name order by table_name)
    into v_names
  from information_schema.tables
  where table_schema = 'public' and table_type = 'BASE TABLE';

  if v_names is null or array_length(v_names, 1) is null then
    return jsonb_build_object('tables', '[]'::jsonb, 'rows', 0);
  end if;

  foreach v_list in array v_names loop
    execute format('select count(*) from public.%I', v_list) into v_count;
    v_total := v_total + v_count;
  end loop;

  -- One statement, every table, so FK references between them are all cleared
  -- together. RESTART IDENTITY resets serials; CASCADE covers any outside refs.
  select string_agg(format('public.%I', table_name), ', ')
    into v_list
  from information_schema.tables
  where table_schema = 'public' and table_type = 'BASE TABLE';
  execute 'truncate table ' || v_list || ' restart identity cascade';

  return jsonb_build_object('tables', to_jsonb(v_names), 'rows', v_total);
end;
$$;

revoke all on function public.admin_assert_public_table(text) from public;
revoke all on function public.admin_export_table(text)        from public;
revoke all on function public.admin_snapshot()                from public;
revoke all on function public.admin_truncate_table(text)      from public;
revoke all on function public.admin_truncate_all()            from public;
grant execute on function public.admin_assert_public_table(text) to service_role;
grant execute on function public.admin_export_table(text)        to service_role;
grant execute on function public.admin_snapshot()                to service_role;
grant execute on function public.admin_truncate_table(text)      to service_role;
grant execute on function public.admin_truncate_all()            to service_role;
