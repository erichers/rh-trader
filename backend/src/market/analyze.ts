import { alpacaData, alpacaConfigured } from '../brokers/alpaca.js';
import { snapshot } from './indicators.js';

export type SymbolAnalysis = {
  symbol: string;
  days: number;
  bars: number;
  last: number;
  period_return_pct: number;
  annualized_vol_pct: number;
  max_gain_pct: number;
  max_drawdown_pct: number;
  high: number;
  low: number;
  dist_from_high_pct: number;
  dist_from_low_pct: number;
  avg_daily_range_pct: number;
  up_days_pct: number;
  indicators: ReturnType<typeof snapshot>;
  trend: 'up' | 'down' | 'sideways';
  note: string;
};

export async function analyzeSymbolStats(symbol: string, days = 90): Promise<SymbolAnalysis | null> {
  if (!alpacaConfigured()) return null;
  const raw = await alpacaData.barsRaw(symbol, '1Day', days + 5).catch(() => [] as any[]);
  if (!raw.length) return null;
  const bars = raw.slice(-days);
  const closes = bars.map((b) => Number(b.c));
  const highs = bars.map((b) => Number(b.h));
  const lows = bars.map((b) => Number(b.l));
  const last = closes[closes.length - 1];
  const first = closes[0];

  // Daily returns for vol.
  const rets: number[] = [];
  for (let i = 1; i < closes.length; i++) rets.push((closes[i] - closes[i - 1]) / closes[i - 1]);
  const mean = rets.reduce((a, b) => a + b, 0) / (rets.length || 1);
  const variance = rets.reduce((a, b) => a + (b - mean) ** 2, 0) / (rets.length || 1);
  const dailyVol = Math.sqrt(variance);
  const annVol = dailyVol * Math.sqrt(252) * 100;

  // Max gain & drawdown over the window.
  let peak = closes[0], trough = closes[0], maxDD = 0, maxGain = 0;
  for (const c of closes) {
    peak = Math.max(peak, c);
    trough = Math.min(trough, c);
    maxDD = Math.min(maxDD, (c - peak) / peak);
    maxGain = Math.max(maxGain, (c - trough) / trough);
  }
  const high = Math.max(...highs);
  const low = Math.min(...lows);
  const avgRange = bars.reduce((a, b) => a + (Number(b.h) - Number(b.l)) / Number(b.c), 0) / bars.length;
  const upDays = rets.filter((r) => r > 0).length;
  const snap = snapshot(closes);
  const trend: SymbolAnalysis['trend'] =
    snap.sma20 != null && snap.sma50 != null
      ? last > snap.sma20 && snap.sma20 > snap.sma50 ? 'up'
      : last < snap.sma20 && snap.sma20 < snap.sma50 ? 'down' : 'sideways'
      : 'sideways';

  const r = (n: number, d = 1) => Math.round(n * 10 ** d) / 10 ** d;
  return {
    symbol,
    days,
    bars: bars.length,
    last: r(last, 2),
    period_return_pct: r(((last - first) / first) * 100),
    annualized_vol_pct: r(annVol),
    max_gain_pct: r(maxGain * 100),
    max_drawdown_pct: r(maxDD * 100),
    high: r(high, 2),
    low: r(low, 2),
    dist_from_high_pct: r(((last - high) / high) * 100),
    dist_from_low_pct: r(((last - low) / low) * 100),
    avg_daily_range_pct: r(avgRange * 100, 2),
    up_days_pct: r((upDays / (rets.length || 1)) * 100),
    indicators: snap,
    trend,
    note: `${symbol}: ${trend} trend, ${r(annVol)}% annualized vol, ${r(avgRange * 100, 2)}% avg daily range over ${bars.length} days.`,
  };
}
