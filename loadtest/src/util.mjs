// Small deterministic helpers: seeded RNG + base58 id/signature generators so
// synthetic wallets and deposit signatures look like the real Solana ones the
// join path expects (base58, case-sensitive, right length).

import { randomUUID } from "node:crypto";

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

// mulberry32 — tiny, fast, seedable PRNG for reproducible scenario choices.
export function makeRng(seed) {
  let a = seed >>> 0;
  return function rng() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function base58(len, rng = Math.random) {
  let s = "";
  for (let i = 0; i < len; i++) s += B58[Math.floor(rng() * B58.length)];
  return s;
}

// A Solana address is 32–44 base58 chars; use 44.
export const wallet = (rng) => base58(44, rng);
// A Solana tx signature is 86–88 base58 chars; use 88, and never repeat one —
// consumed_deposits keys on it and rejects reuse.
export const txSig = (rng) => base58(88, rng);

export const uuid = () => randomUUID();

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
