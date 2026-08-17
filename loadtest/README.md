# FIGHT10 load test — 100 concurrent users

A concurrency + anti-cheat stress harness for the FIGHT10 server, run against an
**isolated local replica** of the Supabase schema. It simulates 100 users
stampeding the parts of the backend that actually contend under load — the
match seat-claim race, the combat write path, the anti-cheat settler, and the
single-winner payout claim — and asserts the invariants each of those paths
exists to guarantee.

## Why it's a local replica, not the live game

FIGHT10 is a **mainnet-beta, real-money** system. Joining a match requires a
real, confirmed on-chain SPL transfer of 10,000 $FIGHT10 to escrow, which
`f10join` verifies on Solana before granting a seat. Simulating 100 users
against the live backend would mean 100 funded wallets and ~1,000,000 real
tokens, would pollute production data, and would trip the rate limiter and ban
heuristics for real players. So the harness stands up a throwaway PostgreSQL
cluster, applies the **real** schema (`supabase/fresh_setup.sql`) on top of a
small Supabase shim, and drives the actual RPCs and triggers there. Nothing in
this directory ever connects to a hosted Supabase project or to Solana.

The on-chain deposit check lives in the edge function, not the database, so the
harness feeds `join_pvp_match` synthetic-but-unique deposit signatures — exactly
the shape the RPC receives *after* the edge function has verified the chain. The
DB-side concurrency and anti-cheat logic it drives is byte-for-byte production.

## What it exercises

Focus areas: **DB concurrency** and **combat / anti-cheat** (the two the schema
actually enforces server-side).

| Phase | Path under test | Race / rule being stressed |
|---|---|---|
| **1. Join stampede** | `join_pvp_match` | Per-user advisory lock (no double-seat), global capacity advisory lock (cap can't be overshot), `for update … skip locked` seat pick (no seat collisions, no two joiners on one match). |
| **2. Combat writes** | `match_damage` insert + `validate_match_damage` | Honest rows accepted at high concurrency; tampered rows (over-ceiling damage, bad timestamps, damage-without-hits, non-member victim) rejected at write time and never leaked into the ledger. |
| **3. Settlement** | `finalize_match(force)`, `ban_forfeited`, `claim_payout_slot` | Rate-cap forfeit (DPS / fire-rate) → auto-ban; correct clean winner selection with a cheater present; and a payout slot that can be claimed **exactly once** under a concurrent claim race. |

Every phase ends by querying the resulting DB state and asserting invariants
(see the `✓` lines in the output). A failing invariant makes the run exit
non-zero, so it can gate CI.

## Running it

```bash
cd loadtest
./run.sh                        # stand up a throwaway cluster + run (100 users)
./run.sh --users 100 --size 10  # flags pass through to the harness
./run.sh stop                   # tear the cluster down
```

`run.sh` needs PostgreSQL 16+ server binaries (`initdb`, `postgres`) on the box;
it creates the cluster in a temp data dir, applies the schema, `npm install`s,
and runs. If you already have a Postgres reachable, skip `run.sh` and point the
harness at it:

```bash
# apply the schema yourself first:
psql "$DB" -f sql/00_supabase_shim.sql
psql "$DB" -f ../supabase/fresh_setup.sql
# then:
PGHOST=… PGPORT=… PGUSER=… PGDATABASE=… npm install && node src/run.mjs
```

**Docker alternative** for the cluster (if you have a daemon):

```bash
docker run -d --name f10pg -e POSTGRES_PASSWORD=postgres -p 55432:5432 postgres:16
```

### Flags

| Flag | Default | Meaning |
|---|---|---|
| `--users N` | 100 | number of virtual users |
| `--size 2\|5\|10` | sweep all three | lobby size for the join phase |
| `--concurrency N` | = users | in-flight join concurrency |
| `--invalid-combat-frac F` | 0.15 | fraction of combat writes that are tampered |
| `--cheater-match-frac F` | 0.5 | fraction of matches seeded with a rate-cap cheater |
| `--payout-claimers N` | 8 | concurrent claimers per finished match |

## Results (100 users, this repo, PostgreSQL 16)

All invariants held. Representative numbers from a local, unthrottled box:

```
PHASE 1 — JOIN STAMPEDE
  size=2   100 users → 50 full matches   p50  910ms   p95 1210ms    80 joins/s
  size=5   100 users → 20 full matches   p50  228ms   p95  348ms   279 joins/s
  size=10  100 users → 10 full matches   p50  180ms   p95  278ms   349 joins/s
    ✓ no duplicate seats · no over-fill · no double-seated user · cap respected

PHASE 2 — COMBAT WRITES + WRITE-TIME ANTI-CHEAT
  10 matches, 900 writes (777 honest / 123 tampered)   1217 honest rows/s
    ✓ all 123 tampered rows rejected by the right validator, 0 leaked

PHASE 3 — SETTLEMENT, FORFEIT/AUTO-BAN & PAYOUT RACE
  10 matches (5 clean / 5 cheater)   finalize p50 42ms
  payout race: 8 claimers × 10 matches = 80 concurrent claims
    ✓ 5/5 cheaters forfeited AND auto-banned · clean winner every time
    ✓ payout claimed exactly once per match — 0 double-claims, 0 unclaimable
```

### The one performance signal worth flagging

Join latency scales with the **number of open matches**, not the number of
users: at 100 users, size-2 (50 lobbies) is ~5× slower per join than size-10 (10
lobbies). The cause is structural — every `join_pvp_match` takes the **global**
`fight10_pvp_capacity` advisory lock and then scans waiting matches with a
per-candidate `count(*)` subquery, so total join work grows with the number of
concurrent lobbies. It stays correct (all invariants pass), but at high lobby
counts join throughput is bounded by that serialized section. If small-lobby
concurrency ever needs to scale, that lock + scan is the place to look (e.g. a
maintained seat-count column, or sharding the capacity lock).

## Caveats

- Absolute latencies come from an unthrottled local cluster with `fsync=off` —
  treat them as **relative / comparative**, not production SLAs. The *behaviours*
  (serialization, rejection, single-flight) are production-accurate.
- Realtime fan-out (chat/presence) and the on-chain deposit/payout signing are
  out of scope by design — this harness targets the DB concurrency and
  anti-cheat surface. The chain layer is stubbed at the RPC boundary.
- The Supabase shim (`sql/00_supabase_shim.sql`) provides only the pieces the
  game schema references (`auth.users`/`auth.identities`/`auth.uid()`, the
  anon/authenticated/service_role roles, pgcrypto, a minimal `realtime`). It is
  not a full GoTrue/Realtime clone.

## Layout

```
loadtest/
  run.sh                     bring up a throwaway cluster + apply schema + run
  sql/00_supabase_shim.sql   minimal Supabase stand-ins so fresh_setup.sql applies
  src/
    config.mjs   run/connection config + CLI flags
    db.mjs       pg pool + asUser() impersonation (sets request.jwt.claim.sub)
    seed.mjs     reset + mint N synthetic users (auth.users + identities)
    metrics.mjs  latency percentiles + bounded-concurrency load generator
    checks.mjs   invariant collector
    scenarios/join.mjs · combat.mjs · settle.mjs
    run.mjs      orchestrator + report (writes results/latest.json)
```
