// Scenario 2 — combat write load + write-time anti-cheat (combat/anti-cheat).
//
// Every seated player concurrently records the damage they dealt to each
// opponent (the Option-A ledger: one aggregated row per attacker→victim). Mixed
// into the honest stream is a configurable fraction of tampered rows, each
// crafted to trip a specific branch of validate_match_damage(). We assert:
//   • honest rows are accepted (and land in the ledger),
//   • every tampered row is rejected at INSERT with a 'cheat_detected:' /
//     'stale:' error and never reaches the table.
// and measure the honest-write latency/throughput under the full concurrent mix.

import { pool } from "../db.mjs";
import { Timer, timed, runPool, nowMs } from "../metrics.mjs";
import { makeRng } from "../util.mjs";
import { Checker } from "../checks.mjs";
import { cfg } from "../config.mjs";

const INVALID_TYPES = ["ceiling", "timestamps", "nohits", "crossvictim"];

function buildTasks(matches, playersByMatch, rng, invalidFrac) {
  const tasks = [];
  const matchIds = matches.map((m) => m.id);
  let inv = 0;
  for (const m of matches) {
    const players = playersByMatch.get(m.id);
    const durMs = m.dur_s * 1000;
    for (const attacker of players) {
      for (const victim of players) {
        if (attacker.user_id === victim.user_id) continue;
        const makeInvalid = rng() < invalidFrac;
        if (!makeInvalid) {
          const dmg = 1 + Math.floor(rng() * 40);
          const hits = Math.max(1, Math.round(dmg / 25));
          const first = Math.floor(rng() * (durMs * 0.5));
          const last = first + Math.floor(rng() * (durMs * 0.4));
          tasks.push({
            kind: "valid",
            match_id: m.id,
            attacker: attacker.user_id,
            victim: victim.user_id,
            total_damage: dmg,
            hit_count: hits,
            first_t_ms: first,
            last_t_ms: last,
          });
        } else {
          inv++;
          const type = INVALID_TYPES[inv % INVALID_TYPES.length];
          const base = {
            kind: "invalid",
            type,
            match_id: m.id,
            attacker: attacker.user_id,
            victim: victim.user_id,
            total_damage: 10,
            hit_count: 1,
            first_t_ms: 0,
            last_t_ms: 1000,
          };
          if (type === "ceiling") {
            base.hit_count = 1;
            base.total_damage = 1 * 250 + 500; // > hit_count * hard-per-hit ceiling
          } else if (type === "timestamps") {
            base.first_t_ms = 5000;
            base.last_t_ms = 1000; // last < first
          } else if (type === "nohits") {
            base.total_damage = 25;
            base.hit_count = 0; // damage without hits
          } else if (type === "crossvictim") {
            // A real user, but one seated in a DIFFERENT match → not a member here.
            const other = matchIds.find((id) => id !== m.id);
            const vict = playersByMatch.get(other)[0];
            base.victim = vict.user_id;
          }
          tasks.push(base);
        }
      }
    }
  }
  return tasks;
}

export async function runCombat(seed) {
  const rng = makeRng(seed ^ 0x9e3779b9);

  const matches = (
    await pool.query(
      `select m.id, m.max_players,
              coalesce(m.duration_seconds, public.match_duration_seconds(m.max_players)) as dur_s
         from public.matches m where m.status='active'`,
    )
  ).rows;
  const playersRows = (
    await pool.query(
      `select match_id, user_id, seat from public.match_players order by match_id, seat`,
    )
  ).rows;
  const playersByMatch = new Map();
  for (const p of playersRows) {
    if (!playersByMatch.get(p.match_id)) playersByMatch.set(p.match_id, []);
    playersByMatch.get(p.match_id).push(p);
  }

  const tasks = buildTasks(matches, playersByMatch, rng, cfg.invalidCombatFrac);

  const timer = new Timer();
  const tally = {
    validAccepted: 0,
    validRejected: 0,
    invalidRejected: 0,
    invalidLeaked: 0,
    badRejectMsg: 0,
    byType: {},
  };
  const rejectSamples = [];

  const t0 = nowMs();
  await runPool(tasks, cfg.concurrency, async (t) => {
    const r = await timed(() =>
      pool.query(
        `insert into public.match_damage
           (match_id, attacker, victim, total_damage, hit_count, first_t_ms, last_t_ms)
         values ($1,$2,$3,$4,$5,$6,$7)`,
        [t.match_id, t.attacker, t.victim, t.total_damage, t.hit_count, t.first_t_ms, t.last_t_ms],
      ),
    );
    if (t.kind === "valid") {
      if (r.ok) {
        timer.push(r.ms);
        tally.validAccepted++;
      } else {
        tally.validRejected++;
        if (rejectSamples.length < 5) rejectSamples.push(`VALID rejected: ${r.error.message}`);
      }
    } else {
      tally.byType[t.type] = tally.byType[t.type] || { rejected: 0, leaked: 0 };
      if (r.ok) {
        tally.invalidLeaked++;
        tally.byType[t.type].leaked++;
      } else {
        tally.invalidRejected++;
        tally.byType[t.type].rejected++;
        const msg = r.error.message || "";
        if (!/^(cheat_detected:|stale:)/.test(msg)) {
          tally.badRejectMsg++;
          if (rejectSamples.length < 5) rejectSamples.push(`unexpected msg: ${msg}`);
        }
      }
    }
  });
  const wallMs = nowMs() - t0;

  const validAttempted = tasks.filter((t) => t.kind === "valid").length;
  const invalidAttempted = tasks.filter((t) => t.kind === "invalid").length;
  const ledger = (await pool.query(`select count(*)::int c from public.match_damage`)).rows[0].c;

  const chk = new Checker("combat writes");
  chk.eq("all honest rows accepted", tally.validAccepted, validAttempted);
  chk.eq("all tampered rows rejected", tally.invalidRejected, invalidAttempted);
  chk.eq("no tampered row leaked into ledger", tally.invalidLeaked, 0);
  chk.eq("ledger row count == honest accepted", ledger, tally.validAccepted);
  chk.eq("every rejection was a cheat/stale error", tally.badRejectMsg, 0);

  return {
    matches: matches.length,
    tasks: tasks.length,
    validAttempted,
    invalidAttempted,
    tally,
    timer,
    wallMs,
    throughput: (tally.validAccepted / wallMs) * 1000,
    rejectSamples,
    checks: chk,
  };
}
