// Connection + run configuration. Everything points at the LOCAL throwaway
// cluster stood up by run.sh — never a hosted Supabase project. Overridable via
// env or CLI flags (--users 100 --size 10 ...).

function flag(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  if (i !== -1 && i + 1 < process.argv.length) return process.argv[i + 1];
  return def;
}
function intFlag(name, def) {
  const v = flag(name, undefined);
  return v === undefined ? def : parseInt(v, 10);
}
function floatFlag(name, def) {
  const v = flag(name, undefined);
  return v === undefined ? def : parseFloat(v);
}

export const db = {
  host: process.env.PGHOST || "127.0.0.1",
  port: parseInt(process.env.PGPORT || "55432", 10),
  user: process.env.PGUSER || "postgres",
  password: process.env.PGPASSWORD || "",
  database: process.env.PGDATABASE || "fight10",
};

export const cfg = {
  // Number of synthetic users (virtual users).
  users: intFlag("users", 100),
  // Lobby size to test the join stampede against. join_pvp_match accepts 2/5/10.
  // The default run (run.mjs) sweeps all three; --size pins a single one.
  size: intFlag("size", 0), // 0 = sweep 2,5,10
  // Concurrency for the join stampede. Defaults to every user firing at once —
  // the true thundering herd.
  concurrency: intFlag("concurrency", 0), // 0 = users
  // Fraction of combat rows that are deliberately malformed, to exercise the
  // write-time anti-cheat validators (validate_match_damage / _kills).
  invalidCombatFrac: floatFlag("invalid-combat-frac", 0.15),
  // How many winners simultaneously race to claim each finished match's payout
  // slot. Exactly one must win (claim_payout_slot single-flight).
  payoutClaimers: intFlag("payout-claimers", 8),
  // Put one rate-cap-busting "cheater" in this fraction of filled matches so the
  // finalize-time DPS/fire-rate forfeit + auto-ban path gets exercised.
  cheaterMatchFrac: floatFlag("cheater-match-frac", 0.5),
  // pg pool ceiling — must exceed peak concurrency.
  poolMax: intFlag("pool-max", 130),
  seed: intFlag("rng-seed", 1337),
};

if (cfg.concurrency === 0) cfg.concurrency = cfg.users;
