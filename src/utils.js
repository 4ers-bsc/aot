export function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// Convert a raw on-chain token amount (integer in the token's smallest unit) to
// a whole-token number for DISPLAY, without the precision loss of
// `Number(raw) / 10 ** decimals` — a 2500-token fee at 18 decimals is 2.5e21,
// far past Number's safe-integer range, so the naive division silently rounds.
// We divide with BigInt first (exact) and only convert the already-small
// whole-token quotient to Number. `raw` may be a bigint, decimal string, or
// number; returns a Number of whole tokens (fractional part dropped, matching
// the app's "maximumFractionDigits: 0" display everywhere).
export function tokensFromRaw(raw, decimals = 18) {
  let v;
  try {
    if (typeof raw === "bigint") {
      v = raw;
    } else if (typeof raw === "number") {
      // supabase-js returns a numeric/bigint column as a JS number, and a large
      // raw amount (e.g. 18000 tokens @ 18 dp = 1.8e22) stringifies to
      // exponential form ("1.8e+22"). Feeding that through String().split(".")
      // would parse just the "1", collapsing a real payout to 0 — so convert the
      // number straight to BigInt (its sub-token low bits are already lost to
      // float rounding, but those get divided away below anyway).
      v = Number.isFinite(raw) ? BigInt(Math.trunc(raw)) : 0n;
    } else {
      v = BigInt(String(raw ?? "0").split(".")[0] || "0");
    }
  } catch (_) {
    return 0;
  }
  if (v < 0n) v = -v;
  const scale = 10n ** BigInt(decimals);
  return Number(v / scale);
}

// Precision-safe, grouped display string for a raw token amount, e.g.
// "2,500". Uses tokensFromRaw() so large raw values never lose precision.
export function formatTokens(raw, decimals = 18) {
  return tokensFromRaw(raw, decimals).toLocaleString(undefined, { maximumFractionDigits: 0 });
}
