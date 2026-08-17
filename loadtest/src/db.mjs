// Thin pg helpers: a shared pool + the impersonation primitive that lets the
// harness act "as" a signed-in user.

import pg from "pg";
import { db, cfg } from "./config.mjs";

// FIGHT10 stores whole-token amounts in bigint columns (pot_tokens etc.); tell
// node-pg to hand bigints back as JS numbers where they comfortably fit so the
// assertions read naturally. (All values here are small: pots, seats, counts.)
pg.types.setTypeParser(20, (v) => (v === null ? null : Number(v))); // int8
pg.types.setTypeParser(1700, (v) => (v === null ? null : Number(v))); // numeric

export const pool = new pg.Pool({ ...db, max: cfg.poolMax });

export async function q(text, params) {
  const c = await pool.connect();
  try {
    return await c.query(text, params);
  } finally {
    c.release();
  }
}

// Run `fn(client)` inside a transaction that impersonates `uid`, exactly the way
// a real request does: Supabase's API gateway sets `request.jwt.claim.sub` from
// the caller's JWT, and auth.uid() reads it. set_config(..., true) scopes the
// GUC to this transaction, so a pooled connection can be reused safely.
export async function asUser(uid, fn) {
  const c = await pool.connect();
  try {
    await c.query("begin");
    await c.query("select set_config('request.jwt.claim.sub', $1, true)", [uid]);
    const out = await fn(c);
    await c.query("commit");
    return out;
  } catch (e) {
    try {
      await c.query("rollback");
    } catch {
      /* connection already errored */
    }
    throw e;
  } finally {
    c.release();
  }
}

// Same as asUser but also binds a realtime topic, in case a path reads
// realtime.topic(). Unused by the core scenarios; kept for parity.
export async function asUserOnTopic(uid, topic, fn) {
  return asUser(uid, async (c) => {
    await c.query("select set_config('realtime.topic', $1, true)", [topic]);
    return fn(c);
  });
}

export async function shutdown() {
  await pool.end();
}
