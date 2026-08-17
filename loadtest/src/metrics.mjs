// Latency bookkeeping + a bounded-concurrency load generator.

export function nowMs() {
  return Number(process.hrtime.bigint() / 1000n) / 1000; // ms, sub-µs precision
}

// Time a single async op. Never throws — returns {ms, ok, value|error}. The
// scenarios classify errors themselves (e.g. an expected 'servers_full').
export async function timed(fn) {
  const t0 = nowMs();
  try {
    const value = await fn();
    return { ms: nowMs() - t0, ok: true, value };
  } catch (error) {
    return { ms: nowMs() - t0, ok: false, error };
  }
}

export class Timer {
  constructor() {
    this.samples = [];
  }
  push(ms) {
    this.samples.push(ms);
  }
  get n() {
    return this.samples.length;
  }
  stats() {
    const s = [...this.samples].sort((a, b) => a - b);
    const n = s.length;
    if (!n) return { n: 0 };
    const pct = (p) => s[Math.min(n - 1, Math.floor((p / 100) * n))];
    const sum = s.reduce((a, b) => a + b, 0);
    return {
      n,
      min: s[0],
      p50: pct(50),
      p90: pct(90),
      p95: pct(95),
      p99: pct(99),
      max: s[n - 1],
      mean: sum / n,
    };
  }
}

// Run `worker(item, i)` over items with at most `concurrency` in flight. Returns
// results in input order. This is the actual concurrency engine — a real 100-VU
// stampede when concurrency >= items.length.
export async function runPool(items, concurrency, worker) {
  const results = new Array(items.length);
  let next = 0;
  const run = async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await worker(items[i], i);
    }
  };
  const lanes = Math.max(1, Math.min(concurrency, items.length));
  await Promise.all(Array.from({ length: lanes }, run));
  return results;
}

// Fire all workers as close to simultaneously as possible (unbounded), then wait
// for the last to finish. Used for the "everyone hits the same waiting match at
// once" bursts, where the point is maximum contention rather than pacing.
export async function burst(items, worker) {
  const t0 = nowMs();
  const results = await Promise.all(items.map((it, i) => worker(it, i)));
  return { results, wallMs: nowMs() - t0 };
}

const pad = (s, w) => String(s).padEnd(w);
const num = (v, d = 1) => (v == null ? "—" : v.toFixed(d));

export function renderLatency(label, timer) {
  const s = timer.stats();
  if (!s.n) return `${pad(label, 26)} (no samples)`;
  return (
    `${pad(label, 26)} n=${pad(s.n, 6)} ` +
    `p50=${pad(num(s.p50) + "ms", 9)} p95=${pad(num(s.p95) + "ms", 9)} ` +
    `p99=${pad(num(s.p99) + "ms", 9)} max=${pad(num(s.max) + "ms", 10)} ` +
    `mean=${num(s.mean)}ms`
  );
}
