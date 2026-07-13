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
    v = typeof raw === "bigint" ? raw : BigInt(String(raw ?? "0").split(".")[0] || "0");
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
