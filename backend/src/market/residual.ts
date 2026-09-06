/**
 * Long-only residual (stat-arb lite) vs a benchmark.
 *
 * Classic pairs would long the cheap leg and short the rich one. This desk is
 * long-only, so we only ever BUY the name when it is cheap vs the benchmark
 * (log-spread z-score below a threshold). We never short the leader.
 *
 * Fail-closed: returns null when either series is too short, non-positive, or
 * the window standard deviation is zero. Callers must treat null as "do not trade".
 */

export const RESIDUAL_WINDOW = 60;

/** Log-spread z-score of `closes` vs `bench` over the last `window` overlapping bars.
 *  Both series must be oldest → newest. Aligns on the tail (most recent bars). */
export function residualZ(
  closes: number[],
  bench: number[],
  window = RESIDUAL_WINDOW,
): number | null {
  if (!Array.isArray(closes) || !Array.isArray(bench)) return null;
  if (window < 20) return null;
  const n = Math.min(closes.length, bench.length);
  if (n < window) return null;
  const s = closes.slice(-n);
  const b = bench.slice(-n);
  const spreads: number[] = [];
  for (let i = 0; i < n; i++) {
    const px = s[i];
    const bx = b[i];
    if (!(px > 0) || !(bx > 0)) continue;
    spreads.push(Math.log(px / bx));
  }
  if (spreads.length < window) return null;
  const slice = spreads.slice(-window);
  const mean = slice.reduce((a, x) => a + x, 0) / slice.length;
  const variance = slice.reduce((a, x) => a + (x - mean) ** 2, 0) / slice.length;
  const sd = Math.sqrt(variance);
  if (!(sd > 0)) return null;
  return (slice[slice.length - 1] - mean) / sd;
}
