#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# FIGHT10 load test — one-shot bring-up + run.
#
# Stands up a THROWAWAY local PostgreSQL cluster, applies the Supabase shim and
# the real schema (supabase/fresh_setup.sql), installs deps, and runs the
# harness. Never touches a hosted Supabase project or Solana — it is a fully
# isolated replica.
#
# Usage:
#   ./run.sh                       # bring up + run with defaults (100 users)
#   ./run.sh --users 100 --size 10 # pass flags through to the harness
#   ./run.sh stop                  # stop + remove the throwaway cluster
#
# Env overrides: F10_PGPORT (55432), F10_PGDATA (cluster dir).
# ---------------------------------------------------------------------------
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/.." && pwd)"
PORT="${F10_PGPORT:-55432}"

# Locate a PostgreSQL 16+ bin dir.
PGBIN="$(pg_config --bindir 2>/dev/null || true)"
if [ -z "$PGBIN" ] || [ ! -x "$PGBIN/initdb" ]; then
  PGBIN="$(ls -d /usr/lib/postgresql/*/bin 2>/dev/null | sort -V | tail -1 || true)"
fi
[ -x "$PGBIN/initdb" ] || { echo "ERROR: PostgreSQL server binaries not found (need initdb)."; exit 1; }

# postgres refuses to run as root, so when root we run the cluster as the
# 'postgres' system user (and place the data dir where that user can reach it).
if [ "$(id -u)" = "0" ] && id postgres >/dev/null 2>&1; then
  PGUSER_SYS="postgres"
  DATADIR="${F10_PGDATA:-/var/lib/postgresql/f10loadtest/data}"
  RUNDIR="$(dirname "$DATADIR")/run"
  as_pg() { runuser -u postgres -- "$@"; }
else
  PGUSER_SYS="$(id -un)"
  DATADIR="${F10_PGDATA:-$HERE/.pgdata/data}"
  RUNDIR="$(dirname "$DATADIR")/run"
  as_pg() { "$@"; }
fi

stop_cluster() {
  if [ -d "$DATADIR" ]; then
    as_pg "$PGBIN/pg_ctl" -D "$DATADIR" -m immediate stop >/dev/null 2>&1 || true
  fi
}

if [ "${1:-}" = "stop" ]; then
  stop_cluster
  rm -rf "$(dirname "$DATADIR")"
  echo "cluster stopped and removed."
  exit 0
fi

echo "==> (re)initialising throwaway cluster at $DATADIR (port $PORT)"
stop_cluster
rm -rf "$(dirname "$DATADIR")"
mkdir -p "$DATADIR" "$RUNDIR"
if [ "$PGUSER_SYS" = "postgres" ]; then chown -R postgres:postgres "$(dirname "$DATADIR")"; fi
chmod 700 "$DATADIR"

as_pg "$PGBIN/initdb" -D "$DATADIR" -U postgres --auth-local=trust --auth-host=trust -E UTF8 >/dev/null
cat >> "$DATADIR/postgresql.conf" <<EOF
port = $PORT
listen_addresses = '127.0.0.1'
unix_socket_directories = '$RUNDIR'
max_connections = 300
shared_buffers = 512MB
fsync = off
synchronous_commit = off
full_page_writes = off
EOF

as_pg "$PGBIN/pg_ctl" -D "$DATADIR" -l "$(dirname "$DATADIR")/pg.log" -w start >/dev/null
as_pg "$PGBIN/psql" -h 127.0.0.1 -p "$PORT" -U postgres -c "drop database if exists fight10;" >/dev/null
as_pg "$PGBIN/psql" -h 127.0.0.1 -p "$PORT" -U postgres -c "create database fight10;" >/dev/null

echo "==> applying Supabase shim + real schema (supabase/fresh_setup.sql)"
as_pg "$PGBIN/psql" -h 127.0.0.1 -p "$PORT" -U postgres -d fight10 -v ON_ERROR_STOP=1 -q \
  -f "$HERE/sql/00_supabase_shim.sql" >/dev/null
as_pg "$PGBIN/psql" -h 127.0.0.1 -p "$PORT" -U postgres -d fight10 -v ON_ERROR_STOP=1 -q \
  -f "$REPO/supabase/fresh_setup.sql" >/dev/null

echo "==> installing harness deps"
( cd "$HERE" && npm install --silent >/dev/null )

echo "==> running load test"
export PGHOST=127.0.0.1 PGPORT="$PORT" PGUSER=postgres PGDATABASE=fight10 PGPASSWORD=
cd "$HERE" && node src/run.mjs "$@"
