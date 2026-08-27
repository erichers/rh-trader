// Pure technical indicators over a close-price series (oldest → newest).

export function sma(values: number[], period: number): number | null {
  if (values.length < period) return null;
  const slice = values.slice(-period);
  return slice.reduce((a, b) => a + b, 0) / period;
}

export function ema(values: number[], period: number): number | null {
  if (values.length < period) return null;
  const k = 2 / (period + 1);
  let e = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < values.length; i++) e = values[i] * k + e * (1 - k);
  return e;
}

export function rsi(values: number[], period = 14): number | null {
  if (values.length < period + 1) return null;
  let gains = 0;
  let losses = 0;
  for (let i = values.length - period; i < values.length; i++) {
    const diff = values[i] - values[i - 1];
    if (diff >= 0) gains += diff;
    else losses -= diff;
  }
  const avgGain = gains / period;
  const avgLoss = losses / period;
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

export function macd(
  values: number[],
  fast = 12,
  slow = 26,
  signal = 9,
): { macd: number; signal: number; hist: number } | null {
  if (values.length < slow + signal) return null;
  const macdLine: number[] = [];
  for (let i = slow; i <= values.length; i++) {
    const window = values.slice(0, i);
    const f = ema(window, fast);
    const s = ema(window, slow);
    if (f == null || s == null) continue;
    macdLine.push(f - s);
  }
  const sig = ema(macdLine, signal);
  if (sig == null) return null;
  const m = macdLine[macdLine.length - 1];
  return { macd: m, signal: sig, hist: m - sig };
}

export function pctChange(values: number[], lookback = 1): number | null {
  if (values.length <= lookback) return null;
  const a = values[values.length - 1 - lookback];
  const b = values[values.length - 1];
  if (!a) return null;
  return ((b - a) / a) * 100;
}

export function stddev(values: number[], period: number): number | null {
  if (values.length < period) return null;
  const slice = values.slice(-period);
  const mean = slice.reduce((a, b) => a + b, 0) / period;
  const variance = slice.reduce((a, b) => a + (b - mean) ** 2, 0) / period;
  return Math.sqrt(variance);
}

export function bollinger(
  values: number[],
  period = 20,
  mult = 2,
): { mid: number; upper: number; lower: number } | null {
  const mid = sma(values, period);
  const sd = stddev(values, period);
  if (mid == null || sd == null) return null;
  return { mid, upper: mid + mult * sd, lower: mid - mult * sd };
}

export function donchian(values: number[], period = 20): { high: number; low: number } | null {
  if (values.length < period) return null;
  const slice = values.slice(-period);
  return { high: Math.max(...slice), low: Math.min(...slice) };
}

/** Trailing consecutive up / down day counts (one is always 0). */
export function streaks(closes: number[]): { up: number; down: number } {
  let up = 0, down = 0;
  for (let i = closes.length - 1; i > 0; i--) { if (closes[i] > closes[i - 1]) up++; else break; }
  for (let i = closes.length - 1; i > 0; i--) { if (closes[i] < closes[i - 1]) down++; else break; }
  return { up, down };
}

/** Realized 1-day % move volatility (stddev of daily % returns over `window`). */
export function dailyVolPct(closes: number[], window = 20): number | null {
  if (closes.length < window + 1) return null;
  const rets: number[] = [];
  for (let i = closes.length - window; i < closes.length; i++) { const a = closes[i - 1], b = closes[i]; if (a > 0) rets.push(((b - a) / a) * 100); }
  if (rets.length < 2) return null;
  const m = rets.reduce((s, r) => s + r, 0) / rets.length;
  const v = rets.reduce((s, r) => s + (r - m) ** 2, 0) / rets.length;
  return Math.sqrt(v);
}

export type IndicatorSnapshot = {
  last: number | null;
  sma20: number | null;
  sma50: number | null;
  sma200: number | null;
  ema9: number | null;
  ema21: number | null;
  ema50: number | null;
  rsi14: number | null;
  macd: ReturnType<typeof macd>;
  bollinger: ReturnType<typeof bollinger>;
  donchian20: ReturnType<typeof donchian>;
  // Donchian over the PRIOR window (excludes the current bar) — use this for
  // breakout/breakdown so a signal isn't computed from the same bar it triggers on.
  donchian20Prior: ReturnType<typeof donchian>;
  change1d: number | null;
  mom5: number | null;   // 5-day % change
  mom10: number | null;  // 10-day % change
  consecUp: number;      // trailing consecutive up days
  consecDown: number;    // trailing consecutive down days
  dailyVol: number | null; // realized 1-day % move stddev (20d) — for vol-expansion
  // Previous-bar values so crossovers can be detected as EVENTS, not states.
  prev: { ema9: number | null; ema21: number | null; sma50: number | null; sma200: number | null; macdHist: number | null; rsi14: number | null };
};

export function snapshot(closes: number[]): IndicatorSnapshot {
  const prior = closes.slice(0, -1); // everything up to (not including) the current bar
  const st = streaks(closes);
  return {
    last: closes.length ? closes[closes.length - 1] : null,
    sma20: sma(closes, 20),
    sma50: sma(closes, 50),
    sma200: sma(closes, 200),
    ema9: ema(closes, 9),
    ema21: ema(closes, 21),
    ema50: ema(closes, 50),
    rsi14: rsi(closes, 14),
    macd: macd(closes),
    bollinger: bollinger(closes),
    donchian20: donchian(closes, 20),
    donchian20Prior: donchian(prior, 20),
    change1d: pctChange(closes, 1),
    mom5: pctChange(closes, 5),
    mom10: pctChange(closes, 10),
    consecUp: st.up,
    consecDown: st.down,
    dailyVol: dailyVolPct(closes, 20),
    prev: { ema9: ema(prior, 9), ema21: ema(prior, 21), sma50: sma(prior, 50), sma200: sma(prior, 200), macdHist: macd(prior)?.hist ?? null, rsi14: rsi(prior, 14) },
  };
}
