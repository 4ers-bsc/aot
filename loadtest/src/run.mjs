// FIGHT10 load-test orchestrator.
//
// Runs three phases against the isolated local replica and prints a report:
//   1. Join stampede (sweep lobby sizes 2 / 5 / 10) — seat-claim race.
//   2. Combat writes + write-time anti-cheat validators.
//   3. Settlement: finalize forfeit/auto-ban + single-winner payout race.
//
// Exit code is non-zero if any invariant failed, so it can gate CI.

import { writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { cfg, db } from "./config.mjs";
import { pool, shutdown, q } from "./db.mjs";
import { reset, seedUsers } from "./seed.mjs";
import { runJoin } from "./scenarios/join.mjs";
import { runCombat } from "./scenarios/combat.mjs";
import { runSettle } from "./scenarios/settle.mjs";
import { renderLatency } from "./metrics.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const line = (c = "─") => c.repeat(78);
const num = (v, d = 1) => (v == null ? "—" : Number(v).toFixed(d));

async function main() {
  const pgv = (await q("select version()")).rows[0].version.split(" ").slice(0, 2).join(" ");
  console.log(line("═"));
  console.log("  FIGHT10 — 100-user concurrency & anti-cheat load test");
  console.log(line("═"));
  console.log(`  target      : ${db.user}@${db.host}:${db.port}/${db.database} (isolated replica)`);
  console.log(`  engine      : ${pgv}`);
  console.log(`  virtual users: ${cfg.users}   concurrency: ${cfg.concurrency}`);
  console.log(`  invalid combat frac: ${cfg.invalidCombatFrac}   cheater-match frac: ${cfg.cheaterMatchFrac}   payout claimers/match: ${cfg.payoutClaimers}`);
  console.log(line());

  const report = { startedAt: new Date().toISOString(), config: cfg, engine: pgv, phases: {} };
  let allPass = true;

  // ---- Phase 1: join stampede sweep ---------------------------------------
  console.log("\nPHASE 1 — JOIN STAMPEDE (seat-claim race)\n");
  const sizes = cfg.size ? [cfg.size] : [2, 5, 10];
  report.phases.join = [];
  for (const size of sizes) {
    await reset();
    const users = await seedUsers(cfg.users, cfg.seed);
    const r = await runJoin(users, size, cfg.seed);
    allPass = allPass && r.checks.passed;
    console.log(`  size=${size}  ${cfg.users} users → ${r.activeMatches} full matches   ${r.checks.passed ? "PASS" : "FAIL"}`);
    console.log(`    ${renderLatency("join_pvp_match", r.timer)}`);
    console.log(`    throughput: ${num(r.throughput)} joins/s over ${num(r.wallMs)}ms wall   outcomes: ${JSON.stringify(r.outcomes)}`);
    if (r.errorSamples.length) console.log(`    errors: ${r.errorSamples.join(" | ")}`);
    console.log(r.checks.render());
    report.phases.join.push({
      size, users: cfg.users, activeMatches: r.activeMatches, outcomes: r.outcomes,
      throughputPerSec: r.throughput, wallMs: r.wallMs, latency: r.timer.stats(),
      pass: r.checks.passed, checks: r.checks.checks,
    });
  }

  // ---- Phase 2: combat writes + validators --------------------------------
  console.log("\n" + line());
  console.log("\nPHASE 2 — COMBAT WRITES + WRITE-TIME ANTI-CHEAT\n");
  await reset();
  {
    const users = await seedUsers(cfg.users, cfg.seed);
    await runJoin(users, 10, cfg.seed); // setup: fill size-10 matches
  }
  const combat = await runCombat(cfg.seed);
  allPass = allPass && combat.checks.passed;
  console.log(`  ${combat.matches} active matches, ${combat.tasks} combat writes (${combat.validAttempted} honest / ${combat.invalidAttempted} tampered)   ${combat.checks.passed ? "PASS" : "FAIL"}`);
  console.log(`    ${renderLatency("match_damage insert", combat.timer)}`);
  console.log(`    honest throughput: ${num(combat.throughput)} rows/s over ${num(combat.wallMs)}ms wall`);
  console.log(`    tampered rejected by type: ${JSON.stringify(combat.tally.byType)}`);
  if (combat.rejectSamples.length) console.log(`    samples: ${combat.rejectSamples.join(" | ")}`);
  console.log(combat.checks.render());
  report.phases.combat = {
    matches: combat.matches, validAttempted: combat.validAttempted, invalidAttempted: combat.invalidAttempted,
    tally: combat.tally, throughputPerSec: combat.throughput, wallMs: combat.wallMs,
    latency: combat.timer.stats(), pass: combat.checks.passed, checks: combat.checks.checks,
  };

  // ---- Phase 3: settlement + payout race ----------------------------------
  console.log("\n" + line());
  console.log("\nPHASE 3 — SETTLEMENT, FORFEIT/AUTO-BAN & PAYOUT RACE\n");
  await reset();
  {
    const users = await seedUsers(cfg.users, cfg.seed);
    await runJoin(users, 10, cfg.seed);
  }
  const settle = await runSettle(cfg.seed);
  allPass = allPass && settle.checks.passed;
  console.log(`  ${settle.matches} matches (${settle.nClean} clean / ${settle.nCheater} with a cheater), ${settle.damageRows} scripted damage rows   ${settle.checks.passed ? "PASS" : "FAIL"}`);
  console.log(`    ${renderLatency("finalize_match(force)", settle.finalizeTimer)}`);
  console.log(`    finalize wall: ${num(settle.finalizeWallMs)}ms   finished-with-winner: ${settle.finishedWithWinner}`);
  console.log(`    ${renderLatency("claim_payout_slot", settle.payoutTimer)}`);
  console.log(`    payout race: ${settle.payoutClaimers} claimers/match → ${JSON.stringify(settle.claimStats)} over ${num(settle.payoutWallMs)}ms`);
  console.log(settle.checks.render());
  report.phases.settle = {
    matches: settle.matches, nClean: settle.nClean, nCheater: settle.nCheater,
    finishedWithWinner: settle.finishedWithWinner, claimStats: settle.claimStats,
    finalizeLatency: settle.finalizeTimer.stats(), payoutLatency: settle.payoutTimer.stats(),
    payoutClaimers: settle.payoutClaimers, pass: settle.checks.passed, checks: settle.checks.checks,
  };

  // ---- Summary -------------------------------------------------------------
  report.finishedAt = new Date().toISOString();
  report.pass = allPass;
  console.log("\n" + line("═"));
  console.log(`  RESULT: ${allPass ? "ALL INVARIANTS HELD ✓" : "INVARIANT FAILURE ✗"}`);
  console.log(line("═"));

  const outDir = join(HERE, "..", "results");
  mkdirSync(outDir, { recursive: true });
  const outFile = join(outDir, "latest.json");
  writeFileSync(outFile, JSON.stringify(report, null, 2));
  console.log(`  full report → ${outFile}\n`);

  await shutdown();
  process.exit(allPass ? 0 : 1);
}

main().catch(async (e) => {
  console.error("\nFATAL:", e);
  try {
    await shutdown();
  } catch {
    /* pool may already be closed */
  }
  process.exit(2);
});
