// Scenario 1 — the join stampede (DB-concurrency focus).
//
// Every virtual user fires public.join_pvp_match at once, all contending for the
// same pool of waiting lobbies. This is the exact path a real crowd hitting
// "Enter" simultaneously drives, and the one that migration
// 20260726_join_pvp_match_hardening.sql was written to make race-safe:
//   • a per-user advisory xact lock (no double-seating one wallet),
//   • a global capacity advisory lock (the cap can't be overshot),
//   • `for update ... skip locked` seat selection (two joiners never grab the
//     same seat, and never collide on the same waiting match).
//
// We measure how that serialization performs under load, then assert the
// invariants it exists to guarantee actually held.

import { pool } from "../db.mjs";
import { Timer, timed, burst } from "../metrics.mjs";
import { txSig, makeRng } from "../util.mjs";
import { Checker } from "../checks.mjs";

const TOKEN = "So11111111111111111111111111111111111111112"; // placeholder mint
const ESCROW = "Escrow1111111111111111111111111111111111111";
const CHAIN_ID = 101; // mainnet-beta sentinel, matches src/network.js

export async function runJoin(users, size, seed) {
  const rng = makeRng(seed ^ (size * 2654435761));
  const timer = new Timer();
  const outcomes = { waiting: 0, active: 0, rejoining: 0, servers_full: 0, error: 0 };
  const errorSamples = [];

  const { results, wallMs } = await burst(users, async (u) => {
    const sig = txSig(rng);
    const r = await timed(() =>
      pool.query(
        `select public.join_pvp_match($1::uuid, $2::smallint, $3, $4, $5, $6, $7::int, $8) as r`,
        [u.id, size, sig, null, u.wallet, TOKEN, CHAIN_ID, ESCROW],
      ),
    );
    timer.push(r.ms);
    if (r.ok) {
      const j = r.value.rows[0].r;
      if (j.rejoining) outcomes.rejoining++;
      else outcomes[j.status] = (outcomes[j.status] || 0) + 1;
      return { ok: true, j };
    }
    const msg = r.error.message || String(r.error);
    if (msg.includes("servers_full")) outcomes.servers_full++;
    else {
      outcomes.error++;
      if (errorSamples.length < 5) errorSamples.push(msg);
    }
    return { ok: false, msg };
  });

  const successNewSeats = outcomes.waiting + outcomes.active;
  const throughput = (successNewSeats / wallMs) * 1000;

  // ---- Invariants (queried from the resulting DB state) --------------------
  const chk = new Checker(`join size=${size}`);

  const seatCollisions = await pool.query(
    `select mp.match_id, count(*) n, count(distinct mp.seat) d
       from public.match_players mp group by mp.match_id
       having count(*) <> count(distinct mp.seat)`,
  );
  chk.ok("no duplicate seats within a match", seatCollisions.rowCount === 0,
    `${seatCollisions.rowCount} offending matches`);

  const overCap = await pool.query(
    `select m.id, count(mp.*) n, m.max_players
       from public.matches m join public.match_players mp on mp.match_id = m.id
       group by m.id, m.max_players having count(mp.*) > m.max_players`,
  );
  chk.ok("no match exceeds max_players", overCap.rowCount === 0,
    `${overCap.rowCount} overfilled matches`);

  const doubleSeated = await pool.query(
    `select mp.user_id, count(*) n
       from public.match_players mp
       join public.matches m on m.id = mp.match_id
       where m.status in ('waiting','active')
       group by mp.user_id having count(*) > 1`,
  );
  chk.ok("no user seated in >1 live match", doubleSeated.rowCount === 0,
    `${doubleSeated.rowCount} double-seated users`);

  const seatSum = await pool.query(
    `select count(*)::int total,
            count(*) filter (where m.status='active')::int active_seats,
            count(*) filter (where m.status='waiting')::int waiting_seats
       from public.match_players mp join public.matches m on m.id = mp.match_id`,
  );
  chk.eq("seats created == successful joins",
    seatSum.rows[0].total, successNewSeats);

  const consumed = await pool.query(`select count(*)::int c from public.consumed_deposits`);
  chk.eq("consumed_deposits == successful joins", consumed.rows[0].c, successNewSeats);

  const activeMatches = await pool.query(
    `select count(*)::int c from public.matches where status='active'`,
  );
  const fullMatches = await pool.query(
    `select count(*)::int c from (
        select m.id from public.matches m
        join public.match_players mp on mp.match_id=m.id
        where m.status='active'
        group by m.id, m.max_players having count(mp.*) = m.max_players) t`,
  );
  chk.eq("every active match is exactly full",
    fullMatches.rows[0].c, activeMatches.rows[0].c);

  const cap = await pool.query(`select public.pvp_capacity_cap() as cap`);
  const live = await pool.query(
    `select count(*)::int c from public.match_players mp
       join public.matches m on m.id=mp.match_id where m.status in ('waiting','active')`,
  );
  chk.ok("live players within capacity cap",
    live.rows[0].c <= cap.rows[0].cap, `live=${live.rows[0].c} cap=${cap.rows[0].cap}`);

  return {
    size,
    users: users.length,
    timer,
    wallMs,
    throughput,
    outcomes,
    errorSamples,
    activeMatches: activeMatches.rows[0].c,
    checks: chk,
  };
}
