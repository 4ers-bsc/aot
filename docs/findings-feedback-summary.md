# FIGHT10 — Findings, Feedback & Suggestions Summary

A consolidated review of every finding, piece of feedback, and open suggestion
recorded across the project's pull requests (**#202–#241** — the full history to
date). There are **no open GitHub issues**, and the only PR comments are
automated Vercel deploy notices — **no human review comments**. Every item below
was captured and addressed in the PR that introduced it, so this table is also
the fix log.

Status legend: ✅ fixed & merged · 🟡 open / follow-up · ♻️ later superseded by
the Solana migration.

---

## 1. Security findings (DB, payout & realtime hardening)

These came out of the database-security, anti-cheat and payout/reliability
audits (PRs #209, #210, #223, #224, #229, #230).

| # | Finding | Severity | Where | Status | PR |
|---|---------|----------|-------|--------|-----|
| S1 | **Privilege escalation** — `admin_resolve_dispute`, `ban_user`, `apply_match_result`, `finalize_match`, `close_stale_matches` were `SECURITY DEFINER` but never revoked from PostgreSQL's default `PUBLIC` execute, so any authenticated user could invoke them via PostgREST RPC (e.g. self-award a disputed match). | Critical | DB | ✅ Revoked from public/anon/authenticated, re-granted to `service_role` only, `ALTER DEFAULT PRIVILEGES … REVOKE` to prevent regressions; `service_role` caller assertion as defense-in-depth. | #224 |
| S2 | **Realtime spoofed hit** — `receiveAttack` applied damage on the `targetId==local` branch even with no valid attacker, so a non-participant could broadcast a spoofed hit and damage the local player directly. | P0 | Client / realtime | ✅ Drop any event whose `fromId` isn't a current opponent; match channel is now a PRIVATE Supabase channel authorized by `realtime.messages` RLS (seat-holders only), with DB-roster gating as defense-in-depth. | #229 |
| S3 | **Payout double-pay window** — the real tx hash was persisted *after* the receipt wait; a receipt timeout could clear the slot back to unpaid and re-pay. | P0/High | Edge fn (`f10treasurer`/`f10admin`) | ✅ Hash persisted immediately after broadcast; only a definitive on-chain revert releases the slot for retry. | #224, #229 |
| S4 | **`mark_payout_resolved` unverified** — an arbitrary/typo'd string could mark a match paid. | High | Edge fn | ✅ Supplied hash must be a confirmed transfer from escrow → winner for at least the winner's share before it's recorded. | #223 |
| S5 | **Escrow nonce race** — concurrent payouts across different matches shared one escrow wallet and could grab the same nonce. | High | Edge fn | ✅ Durable single-flight lock (`escrow_payout_lock` + `begin/end_escrow_payout`) held across nonce assignment + broadcast; TTL lets a crashed holder self-heal. | #224 |
| S6 | **Money-moving fallback fee** — client used a baked-in `ENTRY_FEE` while `loadPvpConfig()` ran fire-and-forget, letting paid actions run against a guessed fee. | High | Client | ✅ `pvpConfigReady` flag gates the paid flow; deposit/`startPvp()` refuse to move money until the authoritative fee/share load. | #224 |
| S7 | **Mutable economics** — `matches` didn't snapshot `entry_fee_tokens` / `winner_share_bps` / `duration`, so an admin config edit could break an in-flight or finished-but-unpaid claim (`winner_share_bps` had no lock at all). | High | DB / edge fn | ✅ Snapshot `entry_fee_tokens`, `winner_share_bps`, `duration_seconds`, `economics_version` at match creation; payout math verifies against the snapshot. | #224, #229 |
| S8 | **Payout to mutable wallet** — winnings could be paid to the profile's current `wallet_address`. | High | Edge fn | ✅ Pay the wallet snapshotted on the winner's seat at entry (`deposit_wallet`, enforced == login wallet at join). | #229 |
| S9 | **Config drift on payout** — a match could be paid after the live token/chain/escrow config had drifted from what the deposit was validated against. | High | DB / edge fn | ✅ `join_pvp_match` freezes token contract, chain id, and escrow onto the match; the payout path refuses if the live config has drifted. | #229 |
| S10 | **Concurrent join → double seat** — the membership check ran before the capacity lock, so one wallet's two concurrent requests could take two seats. | Medium | DB | ✅ Per-user `pg_advisory_xact_lock` taken before the membership check. | #224 |
| S11 | **`finish_match` accepted a waiting player** — a `waiting` player could lock in a final HP before combat began. | Medium | DB | ✅ Only an ACTIVE, started match accepts the authoritative report. | #223 |
| S12 | **Non-atomic dispute resolution** — the edge function did the status flip and `apply_match_result()` as two separate writes; a failure between them left a match `finished` with no stats applied. | Medium | DB / edge fn | ✅ `admin_resolve_dispute` RPC flips status + applies stats in one transaction. | #223 |
| S13 | **RLS too open** — `matches` / `match_players` were world-readable for every active/waiting match. | Medium | DB | ✅ Tightened to participants; lobby "N waiting" badges now come from the `SECURITY DEFINER` aggregate `pvp_waiting_counts()` (counts only, never rows). | #223 |
| S14 | **Precision loss** — `Number(raw) / 10 ** decimals` silently rounds past Number's safe-integer range. | Medium | Client | ✅ BigInt division (`tokensFromRaw` / `formatTokens`) across `main.js` / `admin.js`. | #223 |
| S15 | **Case-sensitive replay** — EVM tx hashes are case-insensitive but were stored/compared exact-match. | Medium | DB / edge fn | ♻️ Fixed for EVM (lowercase-normalize + `lower()` unique indexes), then **reversed** for Solana in #232 — base58 is case-sensitive, so `lower()` was dropped and exact-match constraints kept as the replay guard. | #224 → #232 |
| S16 | **Token-2022 fee-aware deposit verification** — the balance-delta check ("escrow credited exactly the entry fee") breaks on a Token-2022 mint with a transfer fee, where escrow's net credit is `amount − fee`. | High | Edge fn | ✅ Switched to an instruction-level check (player *authorised* an entry-fee transfer into the escrow ATA); scans top-level + CPI instructions, accepts `transfer`/`transferChecked`/`transferCheckedWithFee`, resolves escrow ATA + token program from chain. | #240 (commit `661a10b`) |
| S17 | **Farmed away-seat dispute freeze** — an away player whose client never loaded still counts as "connected" for the 15s grace (`last_seen` defaults to `now()` at join). P1 farms the idle seat and reports a win, but `finalize_match` holds the match open (`v_unreported > 0`) long enough for the corpse to finish loading inside the grace window, fight back, record its own lethal total, and self-report — two contradictory "I won" reports then trip the corroboration guard and freeze a pot P1 had already earned as `disputed`. | High | DB | ✅ A seat that has recorded **no offense of its own** yet already absorbed a lethal total (≥100) was never in the fight — it no longer blocks settlement, so the win settles before the corpse can retaliate; the away player's later combat writes hit a settled match and are rejected as stale. A real fighter (has recorded offense) still blocks settlement until it reports, so a fabricated-lethal match can't early-settle past the corroboration guard. | #210 |
| S18 | **Maintenance mode client-only** — the maintenance overlay is client-side DOM and can be deleted from the console, so on its own it didn't stop a determined user from starting new matches. | Medium | Client / DB | ✅ Authoritative server gate: `is_maintenance()` + a `BEFORE INSERT` trigger on `match_players` rejects every new seat while maintenance is on (the consumed-deposit record + pot bump roll back in-transaction, so the deposit stays reusable once lifted); `f10join` also refuses joins early, before any on-chain work. In-flight matches still settle and pay out. | #209 |

---

## 2. Reliability & functional findings (Solana migration bugs)

The Robinhood-Chain (Ethereum) → Solana migration (#232) introduced a chain of
regressions that all presented as *"balance won't load / shows 0"* or *"could
not load the Solana libraries"*. Common thread: **real errors were being
swallowed, so failures looked like silent success.**

| # | Finding | Impact | Status | PR |
|---|---------|--------|--------|-----|
| R1 | **`Buffer is not defined`** — `@solana/spl-token`'s browser bundle references a bare Node `Buffer` at module-eval time; the import threw and was re-thrown as the generic "Could not load the Solana libraries." | Blocked all Solana lib loading (deposit + balance). | ✅ Lazy `buffer` polyfill chunk; `globalThis.Buffer` set before importing the Solana libs (no boot cost, no CDN). | #233 |
| R2 | **Balance swallowed all errors** — `getFight10Balance()` caught every RPC error and returned `0n`, so a rate-limited / 403 / timed-out read was indistinguishable from a genuine zero. | Funded wallets shown as empty; false "Insufficient $FIGHT10" blocked joins. | ✅ Only the RPC's "could not find account" answer maps to `0n`; other errors propagate. | #233 |
| R3 | **Balance read only from live wallet** — used `wallet.publicKey`, which is null after a reload where the Supabase session restores but the wallet hasn't reconnected. | Balance silently never loaded after reload. | ✅ Display falls back to the session's `profile.wallet_address`; money-moving paths still require the live signing wallet. | #233 |
| R4 | **Wrong token decimals** — client default was `9`, but the `$FIGHT10` Pump.fun mint uses `6` (a 1000× mismatch). | Balance ~1000× too small; false "insufficient"; `transferChecked(decimals=9)` deposits rejected on-chain. | ✅ Default restored to `6`; `resolveTokenDecimals()` reads the mint's real decimals from chain (program-agnostic) and recomputes `ENTRY_FEE_RAW`. | #236 |
| R5 | **Token-2022 ATA mis-derivation** — the mint is owned by the Token-2022 program, but the client derived the balance ATA with the classic SPL program, querying a nonexistent address. | Every funded wallet read as `0`. | ✅ Enumerate the wallet's token accounts by mint (`getParsedTokenAccountsByOwner`, program-agnostic); capture the mint's token program for ATA derivation + deposits + payouts. | #239 |
| R6 | **Balance hidden without env config** — `refreshFight10Balance` bailed on the placeholder mint, and the Eth→Solana round-trip renamed `VITE_FIGHT10_MINT` → `VITE_FIGHT10_TOKEN`. | Deployments on the old env var (or none) never rendered a balance. | ✅ Read `VITE_FIGHT10_TOKEN`, then legacy `VITE_FIGHT10_MINT`, then a built-in default mint. | #237 |
| R7 | **Silent balance-read failures** — the nav chip only revealed itself on a successful read and swallowed every failure to `console.error` (placeholder mint threw building an invalid `PublicKey`). | Chip stayed hidden with no user-facing signal. | ✅ Guard the placeholder; on real failure show `— $FIGHT10` with the reason in a tooltip + click-through to retry. | #235 |
| R8 | **Ops dashboard opaque errors** — data loads threw the generic supabase-js "Edge Function returned a non-2xx status code" and discarded the real reason in the response body. | Operators saw a dead end instead of the actual cause. | ✅ `adminErrorReason()` extracts the real error via `error.context.json()` on data loads (as the mutating actions already did). | #233, #234 |
| R9 | **No deploy-config visibility** — no way to confirm which mint/escrow/RPC the client vs. server actually run with (the usual cause of a stuck balance/deposit). | Hard to diagnose config mismatches. | ✅ New read-only **Deployment** ops tab surfaces client vs. server constants and flags mismatches; secrets redacted (`get_deployment` + `maskRpcUrl`). | #235 |
| R10 | **`admin_db_stats` "longest query" false positive** — counted long-lived background connections (Realtime walsender, pg_cron, autovacuum) as multi-hour stuck queries. | Misleading ops metric. | ✅ Restrict to `backend_type = 'client backend'`. | #219 |
| R11 | **`pot_tokens` under-count** — a migration rewrite reintroduced the stale `2500` entry-fee constant, under-counting `matches.pot_tokens` (e.g. a 2-player pot showed 5,000 instead of 20,000). | Display-only; payouts unaffected (they use the snapshotted fee). | ✅ Restore `10000` + backfill existing matches. | #230 |
| R12 | **CSS class-name collision** — the admin Quick-actions row reused the game menu's `.home-actions` (forces a centered column). | Broken admin layout. | ✅ Renamed to `.home-qa`. | #222 |
| R13 | **Stale README** — stated a **2,500** $FIGHT10 entry fee in two places vs. the actual **10,000**. | Misleading docs. | 🟡 Open (PR #231 proposes deleting it). | #231 |
| R14 | **Holdings board rate-limits itself** — up to 100 per-holder `getParsedTokenAccountsByOwner` calls. | Leaderboard throttled. | ✅ Single `getMultipleParsedAccounts` over derived ATAs (token-program aware). | #240 (commit `661a10b`) |

---

## 3. Feedback-driven improvements (game / UX / ops)

Product- and review-feedback that shaped features rather than fixing defects.

| Area | Feedback → change | PR |
|------|-------------------|-----|
| Game visual | **Arena backdrop rework** — black-and-gold brick masonry between the wire fence and the aurora + a silhouette-free starry black sky; near-black running-bond walls laced with glowing neon-gold grout (both verified tiling seamlessly in headless Chromium). | #202, #203 |
| Game UX | **Settlement feedback** — keep the results overlay (spinner + progress bar) up for the whole walkover-settlement wait instead of hiding it after a fixed 2s; a 15s cooldown countdown that mirrors the server's disconnect-grace window; and copy that reads a long wait as "Opponent disconnected" (server replaying the match to settle) instead of a frozen "Finalizing result…". | #204, #206, #207 |
| Ops UX | **Admin tabs polish + filters.** | #208 |
| Game perf | **Mobile quality tier** — detect constrained devices and dial back the GPU-heavy scene (1024 shadow map, cheaper PCF, 1.5× pixel-ratio cap, MSAA off by default, re-enableable). | #216 |
| Game AI | **Diversify demo AI** — extra raiders cycle sword/pistol/sniper instead of all snipers; melee AI closes into swing range (was frozen at a 22-unit stand-off). | #216 |
| Game UX | **Surface weapon swapping** — add 1–4 swap keys to the hint bar, a per-weapon How-To-Play section, and a first-visit tutorial callout. | #216 |
| Game UX | **Server-full popup retry** flow. | #212 |
| Game audio | **Sound-effects integration.** | #217 |
| Home UX | Buy $FIGHT10 button (holdings tab → DEX Screener), BETA badge, and removal of home-screen direct free-play. | #213, #214, #215 |
| Ops config | Move the PvP **player cap / entry fee / winner share** into a single `pvp_config` table (was hardcoded + duplicated across client and every edge function). | #211 |
| Ops monitoring | Add **DB + edge-function monitoring** and a static-constants editor (DB size/rows/connections/cache-hit, health probes, range-validated config edits audited as review notes). | #218 |
| Ops UX | **Restructure the dashboard** — vertical grouped sidebar (Overview / Operations / Finance / Users / System) + a default **Home** tab with needs-attention banner and deep-linking stat tiles. | #221 |
| Ops UX | **DB metrics on Home** + a self-contained high-contrast slate dashboard theme scoped under `.admin-overlay`. | #222 |
| Ops finance | **Match numbers everywhere & searchable** (`#123` instead of truncated ids) + a paginated **All matches** tab with server-side search. | #227, #228 |

---

## 4. Open suggestions & follow-ups

Explicitly deferred as out-of-scope or needing a live environment.

| Suggestion | Rationale / current state | Source |
|------------|---------------------------|--------|
| **Payout status column + reconciliation worker** | #S3/#S5 are the contained, correct core; a full payout-status column and background reconciler are the remaining architectural pieces. | #224 |
| **Single durable payout job queue** | Same audit recommendation — the queue is the larger architectural half not yet built. | #224 |
| **Wire the match deadline to the snapshotted duration** | #S7 snapshots `duration` onto the match, but deadline math still reads `match_duration_seconds()` live; wiring it to the snapshot is a broad, separate change. | #224 |
| **Shared escrow-signing module ("single signing service")** | Deferred: the Supabase deploy pipeline bundles only each function's own folder, so a `../_shared/` import fails at deploy. The escrow-signing + deposit-verification logic stays **inlined per function**, kept in sync with explicit "edit both together" markers. | #223 |
| **Go-live deployment/config steps** (not code) | Enable the Supabase **Web3 (Solana / SIWS)** provider; apply the Solana migration; set client `VITE_*` + edge-function secrets; **fund the escrow with SOL** (tx fees + one-time rent for a winner's token account); optionally swap the in-arena logo asset. | #232 |
| **Dedicated production RPC** | Several silent-failure fixes surface the real cause; if it's a rate-limited public RPC, set `VITE_SOLANA_RPC_URL` (client) / `RPC_URL(_2/_3)` (edge) to a dedicated endpoint. | #233, #235 |

---

## 5. Note on superseded findings

The project migrated **Solana → Ethereum (Robinhood Chain) → Solana**. A few
EVM-era fixes were deliberately reversed once back on Solana:

- **Lowercase tx-hash normalization (S15)** — dropped; base58 is case-sensitive,
  so exact-match constraints are the replay guard again (#232).
- **`payout_nonce` double-pay guard** — replaced by a **signature + blockhash
  validity** scheme (a retry only re-sends once the recorded blockhash has
  expired) (#232).
- **Token decimals** — walked `18 → 9 → 6` before settling on the mint's real
  on-chain value read at boot (#232 → #236).
- **Robinhood-Chain branding** — the arena "LIVE ON ROBINHOOD CHAIN" logo sign
  and the Robinhood asset on the PvP loading / chain-sign flow (#204, #205) were
  removed on the migration back to Solana (#232); the chain-sign UI is
  chain-neutral again.

---

## 6. Remediation applied in #241

The then-open follow-ups from the sections above were implemented in **PR #241**
(merged). **Verification:** client `npm run build` passes; all three edge functions parse
(esbuild); `fresh_setup.sql` + the new migration `20260801_*` load on Postgres 16
(migration idempotent) and pass functional tests covering the payout lifecycle,
the queue worker RPCs, and the deadline snapshot-vs-live fallback. The money path
that signs/broadcasts on Solana cannot be exercised without a live validator — see
the reconciler note below.

### Tier A — bounded fixes (enabled)

| Item | Change | Files |
|------|--------|-------|
| **Deadline → snapshot** (S7 follow-up) | `finalize_match`, `close_stale_matches`, and the two combat-ledger write guards now use `coalesce(matches.duration_seconds, match_duration_seconds(max_players))`. An admin editing `match_config` mid-match can no longer move an in-flight match's settlement deadline or anti-cheat timestamp window. | `migrations/20260801_*`, `fresh_setup.sql` |
| **Token decimals seed** (R4 tail) | Admin/utils default `9 → 6` to match the 6-dp Pump.fun mint and `main.js`; fixed a stale EVM `?? 18` fallback in the match-history payout display. | `src/admin.js`, `src/utils.js`, `src/main.js` |

### Tier B — payout architecture (additive; reconciler OFF by default)

Design principle: **additive and backward-compatible.** `matches.payout_tx` stays
the on-chain source of truth; the new lifecycle column is *derived from it by
trigger*, so the already-tested edge-function write path is untouched. The
winner-initiated claim path is unchanged in behavior.

| Item | Change | Files |
|------|--------|-------|
| **Payout status column** | `matches.payout_state` (`unpaid → claimed → broadcast → confirmed`), trigger-derived from `payout_tx` and backfilled — cannot drift from the source of truth. | `migrations/20260801_*`, `fresh_setup.sql` |
| **Durable job queue** | `payout_jobs` table + enqueue trigger (on finished+winner) + auto-close when a `payouts` ledger row lands, so a payout no longer depends on the winner returning to click "claim". Backfilled from existing finished-but-unpaid matches. | `migrations/20260801_*`, `fresh_setup.sql` |
| **Reconciliation worker** | `f10treasurer?reconcile=1` drains the queue through the **same** payout core (refactored in-file into `processPayout`) using a service-role slot claim (`claim_payout_slot_service`), with capped exponential-backoff retry (`claim_payout_jobs` / `complete_payout_job`). **Gated behind `RECONCILE_SECRET`** — returns `503` until the secret is set — so nothing auto-moves money on deploy. | `supabase/functions/f10treasurer/index.ts`, `migrations/20260801_*` |
| **Ops visibility** | New **Payout queue** dashboard tab + `f10admin` `payout_queue` action (`payout_queue_stats` + open jobs). | `src/admin.js`, `supabase/functions/f10admin/index.ts` |

**Enabling the reconciler (deliberate, live-environment step):**
1. Validate end-to-end in staging first — it moves real funds.
2. Set the `RECONCILE_SECRET` edge-function secret.
3. Schedule a poll (e.g. `pg_cron` → `net.http_post` to `…/f10treasurer?reconcile=1`
   with header `X-Reconcile-Secret`, every 1–2 min, or an external scheduler).

Until enabled, the queue is **observability-only** and every double-pay guard
(single-flight slot claim, escrow lock, persist-before-broadcast, on-chain
reconcile) is unchanged — so it is safe to ship dark.

### Deliberately not changed

- **Shared escrow-signing module** — still blocked by Supabase bundling each
  function folder in isolation; the "edit both together" duplication stands.
- **Stale README / PR #231** — already moot (the current README has no "2,500").
  PR #231 also carries unrelated additions, so it is left for its author to close
  rather than merged here. **Still open** as of this review.

---

## 7. About this revision

This pass **extends coverage back to the full #202–#241 PR history** (the first
draft scoped only #211–#240) and refreshes statuses. It is **documentation-only —
no code changed.** Newly captured here:

- Two earlier game-integrity fixes folded into the security table — **S17**
  (farmed away-seat dispute freeze, #210) and **S18** (client-only maintenance
  mode, #209).
- The arena backdrop reworks and settlement-UX polish (#202–#208) added to the
  feedback section.
- The Robinhood-Chain branding assets (#204, #205) recorded as superseded by the
  Solana migration.
- #241's remediation confirmed **merged**; #231 confirmed **still open** (and
  moot). No open GitHub issues; the only PR comments are automated Vercel deploy
  notices.
