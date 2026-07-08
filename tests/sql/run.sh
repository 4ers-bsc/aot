#!/usr/bin/env bash
# SQL/RPC money-path tests.
#
# Spins up a throwaway PostgreSQL cluster (no Docker, no Supabase CLI), applies
# the auth shim + supabase/fresh_setup.sql + test helpers, then runs every file
# in tests/sql/cases/. Each case file is self-contained (begin … rollback) and
# any failed assertion raises, failing that file.
#
# Requirements: PostgreSQL 14+ server binaries (initdb/pg_ctl/psql) with the
# pgcrypto extension (postgresql-contrib). Set PGBIN to point at a specific
# bin directory, e.g. PGBIN=/usr/lib/postgresql/16/bin.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
HARNESS="$ROOT/tests/sql/harness"
CASES="$ROOT/tests/sql/cases"
DB=fight10_test

if [ -z "${PGBIN:-}" ]; then
  if command -v initdb >/dev/null 2>&1; then
    PGBIN="$(dirname "$(command -v initdb)")"
  else
    # Debian/Ubuntu keep server binaries off PATH; pick the newest version.
    PGBIN="$(ls -d /usr/lib/postgresql/*/bin 2>/dev/null | sort -V | tail -1 || true)"
  fi
fi
if [ -z "${PGBIN:-}" ] || [ ! -x "$PGBIN/initdb" ]; then
  echo "error: PostgreSQL server binaries not found (install postgresql, or set PGBIN)" >&2
  exit 1
fi

WORK="$(mktemp -d "${TMPDIR:-/tmp}/f10-sqltest.XXXXXX")"
PGDATA="$WORK/data"

# Postgres refuses to run as root (common in CI containers) — hand the whole
# cluster to nobody and wrap every postgres command in a privilege drop.
RUNAS=()
if [ "$(id -u)" = "0" ]; then
  chown nobody "$WORK"
  RUNAS=(setpriv --reuid=nobody --regid=nogroup --clear-groups)
fi

cleanup() {
  "${RUNAS[@]}" "$PGBIN/pg_ctl" -D "$PGDATA" -m immediate stop >/dev/null 2>&1 || true
  rm -rf "$WORK"
}
trap cleanup EXIT

echo "==> starting throwaway postgres ($("$PGBIN/postgres" --version))"
"${RUNAS[@]}" "$PGBIN/initdb" -D "$PGDATA" -U postgres -A trust --no-sync >/dev/null
"${RUNAS[@]}" "$PGBIN/pg_ctl" -D "$PGDATA" -l "$WORK/pg.log" -w \
  -o "-c listen_addresses='' -c unix_socket_directories='$WORK' -c fsync=off -c synchronous_commit=off" \
  start >/dev/null

# client_min_messages=warning hides fresh_setup.sql's benign "does not exist,
# skipping" teardown notices.
PSQL=("${RUNAS[@]}" env PGOPTIONS='-c client_min_messages=warning'
      "$PGBIN/psql" -h "$WORK" -U postgres -X -q -v ON_ERROR_STOP=1)

"${PSQL[@]}" -d postgres -c "create database $DB" >/dev/null

echo "==> applying auth shim + supabase/fresh_setup.sql + helpers"
"${PSQL[@]}" -d "$DB" -f "$HARNESS/00_auth_shim.sql" >/dev/null
"${PSQL[@]}" -d "$DB" -f "$ROOT/supabase/fresh_setup.sql" >/dev/null
"${PSQL[@]}" -d "$DB" -f "$HARNESS/01_test_helpers.sql" >/dev/null

echo "==> running cases"
pass=0 fail=0
for f in "$CASES"/*.sql; do
  name="$(basename "$f" .sql)"
  if out="$("${PSQL[@]}" -d "$DB" -f "$f" 2>&1)"; then
    echo "PASS  $name"
    pass=$((pass + 1))
  else
    echo "FAIL  $name"
    printf '%s\n' "$out" | sed 's/^/      /'
    fail=$((fail + 1))
  fi
done

echo
echo "$pass passed, $fail failed"
[ "$fail" -eq 0 ]
