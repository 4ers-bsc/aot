-- ============================================================================
-- admin_db_stats — read-only database health snapshot for the ops dashboard.
-- ----------------------------------------------------------------------------
-- Powers the "Database" tab in src/admin.js (via the f10admin edge function).
-- Returns one jsonb blob: overall database size, per-table live-row estimates
-- and on-disk sizes, connection counts by state, the oldest running query, and
-- the heap cache-hit ratio. Everything here is a cheap catalog / statistics
-- read — no table scans — so it is safe to call on every dashboard refresh.
--
-- security definer + owned by the migration role so it can read the cluster
-- statistics views (pg_stat_activity across sessions, pg_stat_user_tables).
-- Execute is granted to service_role ONLY: the browser never calls this
-- directly — it goes through f10admin, which is admin-gated. Nothing sensitive
-- is returned (no query text, no user data — just counts and sizes).
--
-- Safe to run on an existing project (idempotent).
-- ============================================================================

create or replace function public.admin_db_stats()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_catalog
as $$
declare
  v_tables      jsonb;
  v_conns       jsonb;
  v_oldest_secs numeric;
  v_cache_ratio numeric;
  v_db_bytes    bigint;
begin
  select pg_database_size(current_database()) into v_db_bytes;

  -- Per-table live-row estimate + total on-disk size (heap + indexes + toast),
  -- biggest first. n_live_tup is the planner's estimate, refreshed by
  -- autovacuum/ANALYZE — accurate enough for a dashboard and free to read.
  select coalesce(jsonb_agg(t order by t_bytes desc), '[]'::jsonb)
    into v_tables
  from (
    select jsonb_build_object(
             'name',        relname,
             'rows',        n_live_tup,
             'dead_rows',   n_dead_tup,
             'total_bytes', pg_total_relation_size(relid),
             'last_vacuum', greatest(last_vacuum, last_autovacuum),
             'last_analyze',greatest(last_analyze, last_autoanalyze)
           ) as t,
           pg_total_relation_size(relid) as t_bytes
    from pg_stat_user_tables
    where schemaname = 'public'
  ) s;

  -- Connections grouped by state (+ the configured ceiling), so the operator
  -- can spot a pool leak or an idle-in-transaction pileup at a glance.
  select jsonb_build_object(
           'total',              count(*),
           'active',             count(*) filter (where state = 'active'),
           'idle',               count(*) filter (where state = 'idle'),
           'idle_in_transaction',count(*) filter (where state = 'idle in transaction'),
           'max',                current_setting('max_connections')::int
         )
    into v_conns
  from pg_stat_activity
  where datname = current_database();

  -- Age of the longest-running non-idle statement (seconds). A large value can
  -- mean a stuck query holding locks.
  select coalesce(max(extract(epoch from (now() - query_start))), 0)
    into v_oldest_secs
  from pg_stat_activity
  where datname = current_database()
    and state = 'active'
    and query_start is not null
    and pid <> pg_backend_pid();

  -- Heap cache-hit ratio across the whole database (blocks served from the
  -- buffer cache vs. read from disk). Healthy OLTP sits well above 0.99.
  select case when (sum(heap_blks_hit) + sum(heap_blks_read)) > 0
              then round(sum(heap_blks_hit)::numeric
                         / (sum(heap_blks_hit) + sum(heap_blks_read)), 4)
              else null end
    into v_cache_ratio
  from pg_statio_user_tables;

  return jsonb_build_object(
    'generated_at',  now(),
    'db_bytes',      v_db_bytes,
    'tables',        v_tables,
    'connections',   v_conns,
    'oldest_query_seconds', round(v_oldest_secs, 1),
    'cache_hit_ratio',      v_cache_ratio
  );
end;
$$;

revoke all on function public.admin_db_stats() from public;
grant execute on function public.admin_db_stats() to service_role;
