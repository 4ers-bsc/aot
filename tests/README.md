# Money-path tests

Automated tests for the paths where tokens move. Two layers, matching where the
logic actually lives:

```
npm test            # both layers
npm run test:sql    # SQL/RPC tests (needs local PostgreSQL server binaries)
npm run test:edge   # edge-function deposit verification (Node only)
```

## `tests/sql/` — SQL/RPC tests

Exercises the database functions from `supabase/fresh_setup.sql` exactly as
deployed. `run.sh` boots a **throwaway PostgreSQL cluster** (no Docker, no
Supabase CLI), applies:

1. `harness/00_auth_shim.sql` — stand-in for the Supabase-managed pieces:
   `anon`/`authenticated`/`service_role` roles, `auth.users`,
   `auth.identities`, and an `auth.uid()` that reads a GUC so tests can
   impersonate any player (`tests.set_uid(...)`);
2. `supabase/fresh_setup.sql` — the real schema, RPCs, triggers and grants;
3. `harness/01_test_helpers.sql` — assertions (`tests.ok/is/throws`) and
   fixtures (`tests.create_player`, `tests.join`, `tests.make_active_1v1`, …).

Each file in `cases/` is independent (wrapped in `begin … rollback`) and covers:

| case | covers |
|---|---|
| `01_join_valid_deposit` | seat + pot + consumed signature, activation on full lobby, bad-input rejects |
| `02_join_reused_deposit` | signature single-use forever (live seat, released seat, own retry), rejoin does not burn a new deposit |
| `03_join_wrong_wallet` | deposit wallet must equal login wallet, chain-prefix normalisation, nothing consumed on reject |
| `04_leave_waiting_match` | seat freed + pot decremented, empty lobby closed, gap seat reuse, active match unaffected |
| `05_finalize_normal_winner` | ledger-derived winner, self-reported HP overridden, stats once, idempotent settlement, stale writes rejected |
| `06_finalize_disconnect_winner` | stale-heartbeat elimination, walkover, reported-then-left keeps the win |
| `07_finalize_no_combat_disputed` | disputed (no winner/stats/payout), sweeper backstop, early-report hold-open guard |
| `08_finalize_impossible_dps` | write-time hard ceiling, DPS-cap forfeit + auto-ban + no rejoin, honest player paid, all-cheater dispute |
| `09_payout_claims` | winner-only claim, double-claim rejected (pending + completed), stale reservation recovery, released-slot retry |

Requirements: PostgreSQL 14+ server binaries with `pgcrypto`
(`postgresql` + `postgresql-contrib` packages). Set `PGBIN` if they're not on
`PATH` or under `/usr/lib/postgresql/*/bin`.

## `tests/edge/` — deposit verification unit tests

The on-chain checks (wrong mint, wrong escrow destination, wrong sender, wrong
amount) live in the edge functions, in the shared predicate
`supabase/functions/_shared/deposit_verify.ts` (imported by both `f10join` and
`f10treasurer`). These tests run it under Node's built-in test runner against
fixtures shaped like `getParsedTransaction` output, and cross-check the
dependency-free base58 canonicalisation against `@solana/web3.js`.

Note: a "wrong mint" deposit is rejected by the **destination** check — an SPL
transfer of a different mint can only credit the escrow's token account for
that mint, never the FIGHT10 ATA both functions resolve on-chain.

## What is deliberately not covered

* On-chain RPC calls themselves (signature status, transaction parsing) — the
  edge functions' network layer is exercised against fixtures, not a validator.
* Frontend/visuals — per project priority, money paths first.
