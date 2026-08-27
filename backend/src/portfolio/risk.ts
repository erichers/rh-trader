import { q, getTradingEnv } from '../db.js';
import { getBars } from '../brokers/index.js';
import { livePrices } from '../market/ticker.js';
import { occToContract } from '../brokers/options.js';
import type { TradingEnv } from '../config.js';

// Portfolio-level risk: aggregate exposure, gross/net DELTA-dollar exposure, per-underlying
// concentration, a correlation matrix of held underlyings, simple first-order stress, and a
// redundancy scan (positions/bots making the SAME directional bet on correlated names).
// Everything is computed from REAL open positions + REAL Alpaca price history — nothing modeled
// beyond the standard Black–Scholes delta used to translate option contracts into share-equivalents.

function normCdf(x: number): number {
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989423 * Math.exp(-x * x / 2);
  let p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  if (x > 0) p = 1 - p;
  return 1 - p;
}
/** Black–Scholes delta of a LONG option. call ∈ (0,1], put ∈ [-1,0). */
function bsDelta(type: 'call' | 'put', S: number, K: number, Tyears: number, sigma: number): number {
  if (S <= 0 || K <= 0) return type === 'call' ? 0.5 : -0.5;
  if (Tyears <= 0 || sigma <= 0) { // at/after expiry → intrinsic delta (0 or ±1)
    const itm = type === 'call' ? S > K : S < K;
    return itm ? (type === 'call' ? 1 : -1) : 0;
  }
  const d1 = (Math.log(S / K) + (sigma * sigma / 2) * Tyears) / (sigma * Math.sqrt(Tyears));
  const nd1 = normCdf(d1);
  return type === 'call' ? nd1 : nd1 - 1;
}
function realizedVol(closes: number[], window = 30): number {
  const c = closes.slice(-(window + 1));
  if (c.length < 5) return 0.3;
  const rets: number[] = [];
  for (let i = 1; i < c.length; i++) rets.push(Math.log(c[i] / c[i - 1]));
  const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
  const variance = rets.reduce((s, r) => s + (r - mean) ** 2, 0) / Math.max(1, rets.length - 1);
  return Math.max(0.05, Math.sqrt(variance) * Math.sqrt(252)); // annualized
}
function r2(n: number, d = 2): number { const f = 10 ** d; return Number.isFinite(n) ? Math.round(n * f) / f : 0; }

function pearson(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  if (n < 8) return 0;
  const x = a.slice(-n), y = b.slice(-n);
  const mx = x.reduce((s, v) => s + v, 0) / n, my = y.reduce((s, v) => s + v, 0) / n;
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) { const dx = x[i] - mx, dy = y[i] - my; sxy += dx * dy; sxx += dx * dx; syy += dy * dy; }
  const denom = Math.sqrt(sxx * syy);
  return denom > 0 ? Math.max(-1, Math.min(1, sxy / denom)) : 0;
}
function dailyReturns(closes: number[]): number[] {
  const r: number[] = [];
  for (let i = 1; i < closes.length; i++) if (closes[i - 1] > 0) r.push((closes[i] - closes[i - 1]) / closes[i - 1]);
  return r;
}

export async function portfolioRisk(envArg?: TradingEnv): Promise<any> {
  const env = envArg ?? (await getTradingEnv());
  const positions = await q<any>('SELECT * FROM positions WHERE env=:env AND qty<>0', { env });
  const account = (await q<any>('SELECT * FROM accounts WHERE env=:env ORDER BY updated_at DESC LIMIT 1', { env }))[0] || null;
  const equity = Number(account?.equity) || Number(account?.portfolio_value) || 0;
  const cash = Number(account?.cash) || 0;

  // Distinct underlyings across equity + option positions (options map to their underlying).
  const legs = positions.map((p: any) => {
    const ac = (p.asset_class || 'equity').toLowerCase();
    const c = ac === 'option' && p.occ_symbol ? occToContract(p.occ_symbol) : null;
    const underlying = (c?.underlying || p.symbol || '').toUpperCase();
    return { p, ac, c, underlying };
  }).filter((l: any) => l.underlying);
  const underlyings = Array.from(new Set(legs.map((l: any) => l.underlying)));

  // Real spot + recent history per underlying (for delta + correlation).
  const spotMap = await livePrices(underlyings).catch(() => ({} as Record<string, number | null>));
  const histMap: Record<string, number[]> = {};
  await Promise.all(underlyings.map(async (u) => { histMap[u] = await getBars(u, '1Day', 90).catch(() => [] as number[]); }));

  const now = Date.now();
  const byUnderlying: Record<string, any> = {};
  let grossExposure = 0, netDelta = 0, longDelta = 0, shortDelta = 0, optionPremium = 0, equityNotional = 0;
  const positionRows: any[] = [];
  for (const l of legs) {
    const u = l.underlying;
    const closes = histMap[u] || [];
    const spot = Number(spotMap[u]) || (closes.length ? closes[closes.length - 1] : Number(l.p.avg_cost)) || 0;
    const qty = Number(l.p.qty) || 0;
    const mv = Number(l.p.market_value) || 0;
    let delta = 0, deltaDollars = 0, kind = l.ac;
    if (l.ac === 'option' && l.c) {
      const T = Math.max(0, (Date.parse(l.c.expiration + 'T16:00:00-04:00') - now) / (365 * 864e5));
      const sigma = realizedVol(closes);
      const d = bsDelta(l.c.type, spot, l.c.strike, T, sigma);
      delta = d;
      deltaDollars = d * qty * 100 * spot; // share-equivalent dollar exposure
      optionPremium += mv;                  // long-option premium = capital at risk
      kind = `${l.c.type} option`;
    } else {
      delta = 1; // long shares
      deltaDollars = qty * spot;
      equityNotional += mv;
    }
    grossExposure += Math.abs(deltaDollars);
    netDelta += deltaDollars;
    if (deltaDollars >= 0) longDelta += deltaDollars; else shortDelta += deltaDollars;
    const b = (byUnderlying[u] ||= { underlying: u, spot: r2(spot), delta_dollars: 0, market_value: 0, positions: 0, options: 0, shares: 0 });
    b.delta_dollars += deltaDollars; b.market_value += mv; b.positions += 1;
    if (l.ac === 'option') b.options += 1; else b.shares += qty;
    positionRows.push({ symbol: l.p.symbol, underlying: u, kind, qty, market_value: r2(mv), delta: r2(delta, 3), delta_dollars: r2(deltaDollars), occ_symbol: l.p.occ_symbol || null });
  }
  for (const u of Object.keys(byUnderlying)) {
    const b = byUnderlying[u];
    b.delta_dollars = r2(b.delta_dollars); b.market_value = r2(b.market_value);
    b.pct_of_equity = equity > 0 ? r2((Math.abs(b.delta_dollars) / equity) * 100, 1) : null;
    b.pct_of_gross = grossExposure > 0 ? r2((Math.abs(b.delta_dollars) / grossExposure) * 100, 1) : null;
  }
  const underlyingRows = Object.values(byUnderlying).sort((a: any, b: any) => Math.abs(b.delta_dollars) - Math.abs(a.delta_dollars));
  const largest = underlyingRows[0] || null;

  // Correlation matrix across held underlyings (daily-return Pearson over ~90d).
  const retMap: Record<string, number[]> = {};
  for (const u of underlyings) retMap[u] = dailyReturns(histMap[u] || []);
  const matrix: { a: string; b: string; corr: number }[] = [];
  for (let i = 0; i < underlyings.length; i++) {
    for (let j = i + 1; j < underlyings.length; j++) {
      const a = underlyings[i], b = underlyings[j];
      matrix.push({ a, b, corr: r2(pearson(retMap[a], retMap[b]), 2) });
    }
  }

  // Redundancy: pairs of held underlyings with SAME-SIGN delta and high correlation = effectively
  // one concentrated bet. Plus enabled bots that target overlapping symbols (same directional engine).
  const redundancies: any[] = [];
  for (const m of matrix) {
    if (Math.abs(m.corr) < 0.7) continue;
    const da = byUnderlying[m.a]?.delta_dollars || 0, db = byUnderlying[m.b]?.delta_dollars || 0;
    if (da === 0 || db === 0) continue;
    const sameSide = (da > 0) === (db > 0);
    if (m.corr >= 0.7 && sameSide) redundancies.push({ a: m.a, b: m.b, corr: m.corr, kind: 'correlated same-direction exposure', combined_delta_dollars: r2(da + db) });
    if (m.corr <= -0.7 && !sameSide) redundancies.push({ a: m.a, b: m.b, corr: m.corr, kind: 'offsetting (hedge) exposure', combined_delta_dollars: r2(da + db) });
  }
  // Bot overlap: enabled bots whose symbol sets intersect (the same bet run by multiple bots).
  const bots = await q<any>('SELECT id, name, enabled, symbols FROM bots WHERE enabled=1 AND env=:env', { env });
  const botSyms = bots.map((b: any) => ({ id: b.id, name: b.name, syms: (typeof b.symbols === 'string' ? safe(b.symbols) : b.symbols) || [] }));
  const botOverlap: any[] = [];
  for (let i = 0; i < botSyms.length; i++) for (let j = i + 1; j < botSyms.length; j++) {
    const shared = botSyms[i].syms.filter((s: string) => botSyms[j].syms.includes(s));
    if (shared.length) botOverlap.push({ a: botSyms[i].name, b: botSyms[j].name, shared });
  }

  // First-order stress: portfolio P/L under broad adverse moves (delta-based, % of equity).
  const stress = [-5, -2, -1, 1, 2, 5].map((mv) => {
    const pl = netDelta * (mv / 100);
    return { move_pct: mv, pl_usd: r2(pl), pl_pct_equity: equity > 0 ? r2((pl / equity) * 100, 2) : null };
  });

  const grossPctEquity = equity > 0 ? r2((grossExposure / equity) * 100, 1) : null;
  const netPctEquity = equity > 0 ? r2((netDelta / equity) * 100, 1) : null;
  const flags: string[] = [];
  if (largest && equity > 0 && (Math.abs(largest.delta_dollars) / equity) * 100 > 40) flags.push(`Concentrated: ${largest.underlying} is ${largest.pct_of_equity}% of equity (delta-adjusted).`);
  if (grossPctEquity != null && grossPctEquity > 150) flags.push(`High gross leverage: ${grossPctEquity}% of equity in delta-dollar exposure.`);
  if (equity > 0 && (optionPremium / equity) * 100 > 30) flags.push(`${r2((optionPremium / equity) * 100, 1)}% of equity in long-option premium (full loss if they expire worthless).`);
  if (redundancies.some((r) => r.kind.startsWith('correlated'))) flags.push('Correlated positions are doubling the same directional bet — true diversification is lower than the position count suggests.');

  return {
    env, as_of: new Date().toISOString(),
    account: { equity: r2(equity), cash: r2(cash) },
    totals: {
      positions: positionRows.length, underlyings: underlyings.length,
      gross_exposure: r2(grossExposure), net_delta_dollars: r2(netDelta),
      long_delta_dollars: r2(longDelta), short_delta_dollars: r2(shortDelta),
      option_premium_at_risk: r2(optionPremium), equity_notional: r2(equityNotional),
      gross_pct_equity: grossPctEquity, net_pct_equity: netPctEquity,
    },
    largest_underlying: largest,
    underlyings: underlyingRows,
    positions: positionRows.sort((a, b) => Math.abs(b.delta_dollars) - Math.abs(a.delta_dollars)),
    correlation: matrix.sort((a, b) => Math.abs(b.corr) - Math.abs(a.corr)),
    redundancies, bot_overlap: botOverlap,
    stress, flags,
    notes: 'Delta-dollars translate each option into its share-equivalent exposure via Black–Scholes delta (real spot, realized vol). Correlations are 90-day daily-return Pearson on real Alpaca bars. Stress is first-order (delta only) — it ignores gamma/vega, so big moves on short-DTE options will exceed these straight-line estimates.',
  };
}

function safe(s: any): any { try { return typeof s === 'string' ? JSON.parse(s) : s; } catch { return null; } }
