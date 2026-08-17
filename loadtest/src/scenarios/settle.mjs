// Scenario 3 — settlement, finalize-time anti-cheat, and the payout race
// (DB-concurrency + anti-cheat).
//
// Each filled match is scripted into a known outcome, then settled concurrently
// through the authoritative settler finalize_match(force):
//   • CLEAN match: seat 1 lands capped, legal lethal damage on everyone → seat 1
//     wins, nobody forfeited.
//   • CHEATER match: an extra player pours out damage far above the DPS/fire-rate
//     ceilings (each row still under the write-time per-hit cap, so it only trips
//     finalize's rate math). finalize must forfeit that player, the ban_forfeited
//     trigger must auto-ban them, and a CLEAN seat 1 must still win.
// Then, for every finished match, `payoutClaimers` winners hammer
// claim_payout_slot at once — exactly one may win the slot.

import { pool, asUser } from "../db.mjs";
import { Timer, timed, runPool, nowMs } from "../metrics.mjs";
import { Checker } from "../checks.mjs";
import { cfg } from "../config.mjs";

const STEP = 3000; // ms between the winner's successive attacks (spreads DPS)

// Build the damage rows that script a match's outcome.
function scriptMatch(match, players, isCheater) {
  const rows = [];
  const winner = players[0];
  const cheater = isCheater ? players[players.length - 1] : null;

  // Winner's legal, capped, lethal damage. Skip the cheater (size>2) so the
  // winner takes no cheat damage and stays unambiguously on top; at size 2 the
  // only opponent IS the cheater, so the winner must hit them.
  const winnerVictims = players.filter(
    (p) => p.user_id !== winner.user_id && (!cheater || p.user_id !== cheater.user_id),
  );
  const victimsForWinner =
    winnerVictims.length > 0 ? winnerVictims : players.filter((p) => p.user_id !== winner.user_id);
  victimsForWinner.forEach((v, i) => {
    rows.push({
      match_id: match.id,
      attacker: winner.user_id,
      victim: v.user_id,
      total_damage: 100, // lethal, == 50 dps * 2s win → at cap, not over
      hit_count: 4,
      first_t_ms: i * STEP,
      last_t_ms: i * STEP + 2000,
    });
  });

  // Cheater's rate-illegal burst: 200 dmg/victim in a 200ms window. Each row is
  // write-legal (200 <= hit_count*250), but the attacker's total output blows
  // past 50 dps → finalize flags + forfeits them.
  if (cheater) {
    const cheatVictims = players.filter(
      (p) => p.user_id !== cheater.user_id && (players.length <= 2 || p.user_id !== winner.user_id),
    );
    for (const v of cheatVictims) {
      rows.push({
        match_id: match.id,
        attacker: cheater.user_id,
        victim: v.user_id,
        total_damage: 200,
        hit_count: 1,
        first_t_ms: 0,
        last_t_ms: 200,
      });
    }
  }
  return { rows, winner, cheater };
}

export async function runSettle(seed) {
  const matches = (
    await pool.query(`select id, max_players from public.matches where status='active' order by created_at`)
  ).rows;
  const playersRows = (
    await pool.query(`select match_id, user_id, seat from public.match_players order by match_id, seat`)
  ).rows;
  const playersByMatch = new Map();
  for (const p of playersRows) {
    if (!playersByMatch.get(p.match_id)) playersByMatch.set(p.match_id, []);
    playersByMatch.get(p.match_id).push(p);
  }

  const nCheater = Math.floor(matches.length * cfg.cheaterMatchFrac);
  const scripts = matches.map((m, i) => {
    const isCheater = i < nCheater;
    const s = scriptMatch(m, playersByMatch.get(m.id), isCheater);
    return { match: m, isCheater, ...s };
  });

  // --- Write the scripted damage concurrently (all valid → all accepted) -----
  const dmgTasks = scripts.flatMap((s) => s.rows);
  await runPool(dmgTasks, cfg.concurrency, async (r) => {
    await pool.query(
      `insert into public.match_damage
         (match_id, attacker, victim, total_damage, hit_count, first_t_ms, last_t_ms)
       values ($1,$2,$3,$4,$5,$6,$7)`,
      [r.match_id, r.attacker, r.victim, r.total_damage, r.hit_count, r.first_t_ms, r.last_t_ms],
    );
  });

  // --- Finalize every match at once (force settle) --------------------------
  const finalizeTimer = new Timer();
  const t0 = nowMs();
  await runPool(scripts, cfg.concurrency, async (s) => {
    const r = await timed(() => pool.query(`select public.finalize_match($1, true)`, [s.match.id]));
    finalizeTimer.push(r.ms);
    if (!r.ok) s.finalizeError = r.error.message;
  });
  const finalizeWallMs = nowMs() - t0;

  // --- Verify settlement outcomes -------------------------------------------
  const chk = new Checker("settlement + anti-cheat");
  let cleanFinished = 0,
    cheaterFinished = 0,
    forfeitedCorrect = 0,
    bannedCorrect = 0,
    disputed = 0,
    wrongWinner = 0,
    finalizeErrors = 0;

  const finishedWithWinner = [];
  for (const s of scripts) {
    if (s.finalizeError) finalizeErrors++;
    const m = (
      await pool.query(
        `select status, winner_user_id, forfeited_user_ids from public.matches where id=$1`,
        [s.match.id],
      )
    ).rows[0];
    if (m.status === "disputed") disputed++;
    const winnerOk = m.winner_user_id === s.winner.user_id;
    if (m.status === "finished" && winnerOk) finishedWithWinner.push({ id: s.match.id, winner: s.winner.user_id });
    if (m.status === "finished" && !winnerOk) wrongWinner++;

    if (s.isCheater) {
      if (m.status === "finished" && winnerOk) cheaterFinished++;
      const forfeited = m.forfeited_user_ids || [];
      if (forfeited.includes(s.cheater.user_id)) forfeitedCorrect++;
      const banned = (
        await pool.query(`select 1 from public.banned_users where user_id=$1`, [s.cheater.user_id])
      ).rowCount;
      if (banned) bannedCorrect++;
    } else {
      const forfeited = m.forfeited_user_ids || [];
      if (m.status === "finished" && winnerOk && forfeited.length === 0) cleanFinished++;
    }
  }

  const nClean = matches.length - nCheater;
  chk.eq("no finalize errors", finalizeErrors, 0);
  chk.eq("clean matches → seat 1 wins, no forfeits", cleanFinished, nClean);
  chk.eq("cheater matches → clean seat 1 still wins", cheaterFinished, nCheater);
  chk.eq("cheater forfeited by finalize", forfeitedCorrect, nCheater);
  chk.eq("cheater auto-banned by trigger", bannedCorrect, nCheater);
  chk.eq("no match landed on the wrong winner", wrongWinner, 0);
  chk.eq("no clean match got disputed", disputed, 0);

  // --- Payout race: N winners claim the same slot at once → exactly one wins --
  const payoutTimer = new Timer();
  let doubleClaims = 0,
    zeroClaims = 0,
    singleClaims = 0;
  const p0 = nowMs();
  await runPool(finishedWithWinner, Math.max(1, Math.floor(cfg.concurrency / cfg.payoutClaimers)), async (fm) => {
    const claimers = Array.from({ length: cfg.payoutClaimers });
    const results = await Promise.all(
      claimers.map(async () => {
        const r = await timed(() =>
          asUser(fm.winner, (c) => c.query(`select public.claim_payout_slot($1) as won`, [fm.id])),
        );
        payoutTimer.push(r.ms);
        return r.ok ? r.value.rows[0].won : null;
      }),
    );
    const wins = results.filter((x) => x === true).length;
    if (wins === 1) singleClaims++;
    else if (wins === 0) zeroClaims++;
    else doubleClaims++;
  });
  const payoutWallMs = nowMs() - p0;

  chk.eq("payout claimed exactly once per match", singleClaims, finishedWithWinner.length);
  chk.eq("no match paid twice (double-claim)", doubleClaims, 0);
  chk.eq("no finished match left unclaimable", zeroClaims, 0);

  return {
    matches: matches.length,
    nClean,
    nCheater,
    damageRows: dmgTasks.length,
    finalizeTimer,
    finalizeWallMs,
    finishedWithWinner: finishedWithWinner.length,
    payoutTimer,
    payoutWallMs,
    payoutClaimers: cfg.payoutClaimers,
    claimStats: { singleClaims, doubleClaims, zeroClaims },
    checks: chk,
  };
}
