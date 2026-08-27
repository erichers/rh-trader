import { q, exec, getTradingEnv } from '../db.js';
import { alpacaPaper, alpacaConfigured } from '../brokers/alpaca.js';
import type { TradingEnv } from '../config.js';

export type PnlWindow = { pl: number; pct: number; from: number; partial: boolean };
export type PnlResult = {
  source: 'alpaca_history' | 'equity_snapshots' | 'unavailable';
  env: TradingEnv;
  current: number;
  asOf: number | null;
  windows: Record<'day' | 'week' | 'month' | 'd90' | 'ytd' | 'all', PnlWindow | null>;
  series: { t: number; equity: number }[];
  /** Today's 5-minute equity curve, starting at the prior close (the same baseline the
   *  `day` window measures against). Present only for brokers with an intraday history
   *  API; omitted rather than faked for everyone else. */
  intraday?: { t: number; equity: number }[];
  reason?: string;
};

const DAY = 86400;

/** The broker's equity history ends at the PRIOR session close, so the raw series stops
 *  short of the equity every P/L window is measured against. Append the live account
 *  point (never replacing a recorded one) so a chart drawn from `series` ends exactly
 *  where the numbers do. Skipped when the last recorded point already IS today's live
 *  equity, so we never draw a duplicate. */
function withLivePoint(points: { t: number; equity: number }[], current: number, nowSec: number): { t: number; equity: number }[] {
  if (!Number.isFinite(current) || current <= 0) return points;
  const last = points[points.length - 1];
  if (last && Math.abs(last.equity - current) < 0.005 && nowSec - last.t < DAY) return points;
  return [...points, { t: Math.max(nowSec, (last?.t ?? 0) + 1), equity: current }];
}

let cache: { at: number; env: TradingEnv; data: PnlResult } | null = null;

/** Windowed account P/L (day / week / month / 90d / YTD) from the broker's REAL equity
 *  history. Alpaca exposes an exact equity time series; we slice it per window so every
 *  number traces to actual account values (never modeled/sample data). Accounts without a
 *  history API (Robinhood) use the daily equity_snapshots this app records per env, so P/L
 *  is tied to the ACCOUNT and a new account starts with no history. Cached ~30s. */
export async function pnlWindows(envArg?: TradingEnv): Promise<PnlResult> {
  const env = envArg ?? (await getTradingEnv());
  if (cache && cache.env === env && Date.now() - cache.at < 30_000) return cache.data;

  const empty = (source: 'unavailable', reason: string): PnlResult => ({
    source, env, current: 0, asOf: null,
    windows: { day: null, week: null, month: null, d90: null, ytd: null, all: null },
    series: [], intraday: [], reason,
  });

  // Alpaca exposes a real equity time series. Every other account (Robinhood) gets its
  // windows from the daily equity_snapshots this app records itself — same shape, same
  // honesty rules: a window with no recorded baseline yet returns null, never a guess.
  if (env !== 'alpaca_paper') {
    const data = await snapshotWindows(env);
    cache = { at: Date.now(), env, data };
    return data;
  }
  if (!alpacaConfigured()) return empty('unavailable', 'Alpaca is not configured.');

  // LIVE account is the source of truth for "current" (so it matches the Equity card)
  // and for today's change (Alpaca defines day change as equity − last_equity, where
  // last_equity is the PRIOR session close). Portfolio history supplies the older
  // baselines (week/month/90d/YTD). NOTE: the history series' last point is the prior
  // close, NOT today's live equity — so we must NOT use it as "current".
  let hist: any; let acct: any; let intra: any = null;
  try {
    // The intraday curve is best-effort: it only powers the 1D chart, so a failure
    // there must never take down the windows the whole UI depends on.
    [acct, hist, intra] = await Promise.all([
      alpacaPaper.account(),
      alpacaPaper.portfolioHistory('1A', '1D'),
      alpacaPaper.portfolioHistory('1D', '5Min').catch(() => null),
    ]);
  } catch (e: any) {
    return empty('unavailable', `Could not load account/equity history: ${e?.message || e}`);
  }

  const current = Number(acct?.equity);
  const lastEquity = Number(acct?.last_equity); // prior session close
  if (!Number.isFinite(current) || current <= 0) return empty('unavailable', 'No live equity from broker.');

  const ts: number[] = hist?.timestamp || [];
  const eq: number[] = hist?.equity || [];
  const series = ts
    .map((t, i) => ({ t: Number(t), equity: Number(eq[i]) }))
    .filter((p) => Number.isFinite(p.t) && Number.isFinite(p.equity) && p.equity > 0);

  const nowSec = Math.floor(Date.now() / 1000);
  // Anchor the lookback cutoffs to the latest history timestamp (≈ today) when present,
  // else to wall-clock now.
  const anchor = series.length ? series[series.length - 1].t : nowSec;
  const yearStart = Math.floor(Date.UTC(new Date(anchor * 1000).getUTCFullYear(), 0, 1) / 1000);

  // Baseline = the last recorded equity AT OR BEFORE a cutoff time. `partial` flags that
  // our history doesn't reach back far enough (so the window is shorter than requested).
  const baselineAt = (cutoff: number): { equity: number; t: number; partial: boolean } | null => {
    if (!series.length) return null;
    let chosen = series[0];
    for (const p of series) { if (p.t <= cutoff) chosen = p; else break; }
    return { equity: chosen.equity, t: chosen.t, partial: series[0].t > cutoff };
  };

  // Every window is current(live) − baseline, so they all share one reference point.
  const mk = (base: { equity: number; t: number; partial: boolean } | null): PnlWindow | null => {
    if (!base || base.equity <= 0) return null;
    const pl = current - base.equity;
    return { pl: Math.round(pl * 100) / 100, pct: Math.round((pl / base.equity) * 10000) / 100, from: base.t, partial: base.partial };
  };

  // Day change uses Alpaca's own prior-close (last_equity) — the brokerage-accurate number.
  const day: PnlWindow | null = Number.isFinite(lastEquity) && lastEquity > 0
    ? { pl: Math.round((current - lastEquity) * 100) / 100, pct: Math.round(((current - lastEquity) / lastEquity) * 10000) / 100, from: anchor - DAY, partial: false }
    : mk(baselineAt(anchor - DAY));

  const windows = {
    day,
    week: mk(baselineAt(anchor - 7 * DAY)),
    month: mk(baselineAt(anchor - 30 * DAY)),
    d90: mk(baselineAt(anchor - 90 * DAY)),
    ytd: mk(baselineAt(yearStart)),
    all: mk(series.length ? { equity: series[0].equity, t: series[0].t, partial: false } : null), // since first recorded equity
  };

  // Today's curve for the 1D chart: prior close (Alpaca's base_value, the exact day
  // baseline) followed by the session's 5-minute marks and the live equity, so the
  // chart's start and end match the day P/L figure end for end.
  const intraTs: number[] = intra?.timestamp || [];
  const intraEq: number[] = intra?.equity || [];
  const intraPts = intraTs
    .map((t, i) => ({ t: Number(t), equity: Number(intraEq[i]) }))
    .filter((pt) => Number.isFinite(pt.t) && Number.isFinite(pt.equity) && pt.equity > 0);
  const base = Number(intra?.base_value);
  if (intraPts.length && Number.isFinite(base) && base > 0) intraPts.unshift({ t: intraPts[0].t - 300, equity: base });
  const intraday = intraPts.length ? withLivePoint(intraPts, current, nowSec) : [];

  const data: PnlResult = { source: 'alpaca_history', env, current, asOf: nowSec, windows, series: withLivePoint(series, current, nowSec), intraday };
  cache = { at: Date.now(), env, data };
  return data;
}


/** Record TODAY's equity for one account (idempotent per day). Called by the worker after
 *  every broker sync; these rows are the P/L history for brokers with no history API.
 *  The date comes from the DATABASE clock — the Node process and MySQL can disagree on
 *  timezone, and a future-stamped row would silently hide today from every window. */
export async function recordEquitySnapshot(env: TradingEnv): Promise<void> {
  await exec(
    `INSERT INTO equity_snapshots (env, snap_date, equity, cash, buying_power)
     SELECT :env, CURDATE(), a.equity, a.cash, a.buying_power
       FROM accounts a WHERE a.env=:env AND a.equity IS NOT NULL
         AND a.updated_at >= NOW() - INTERVAL 15 MINUTE  -- never snapshot a stale account row as today's equity
      ORDER BY a.updated_at DESC LIMIT 1
     ON DUPLICATE KEY UPDATE equity=VALUES(equity), cash=VALUES(cash), buying_power=VALUES(buying_power)`,
    { env },
  );
}

/** P/L windows built from this app's own daily equity_snapshots, with the live `accounts`
 *  row as the current point. A window is returned ONLY when a real recorded baseline
 *  exists at or before its cutoff; otherwise it is null ("not enough history yet"). */
async function snapshotWindows(env: TradingEnv): Promise<PnlResult> {
  const rows = await q<{ snap_date: string; equity: any }>(
    `SELECT DATE_FORMAT(snap_date,'%Y-%m-%d') snap_date, equity FROM equity_snapshots
      WHERE env=:env AND equity IS NOT NULL ORDER BY snap_date ASC`, { env },
  );
  const [acct] = await q<{ equity: any }>(
    'SELECT equity FROM accounts WHERE env=:env ORDER BY updated_at DESC LIMIT 1', { env },
  );
  // "Today" per the DATABASE clock (the same clock that stamps the snapshots).
  const [dbDay] = await q<{ today: string }>("SELECT DATE_FORMAT(CURDATE(),'%Y-%m-%d') today");
  const series = rows
    .map((r) => ({ t: Math.floor(new Date(`${r.snap_date}T00:00:00Z`).getTime() / 1000), equity: Number(r.equity) }))
    .filter((p) => Number.isFinite(p.t) && Number.isFinite(p.equity) && p.equity > 0);

  const liveEquity = Number(acct?.equity);
  const current = Number.isFinite(liveEquity) ? liveEquity : (series.length ? series[series.length - 1].equity : 0);
  const nowSec = Math.floor(Date.now() / 1000);
  const todayStart = Math.floor(new Date(`${dbDay?.today || new Date().toISOString().slice(0, 10)}T00:00:00Z`).getTime() / 1000);
  const yearStart = Math.floor(Date.UTC(new Date(nowSec * 1000).getUTCFullYear(), 0, 1) / 1000);

  // Baseline = the last snapshot AT OR BEFORE the cutoff. No such snapshot => no baseline.
  const baselineAt = (cutoff: number) => {
    let chosen: { t: number; equity: number } | null = null;
    for (const p of series) { if (p.t <= cutoff) chosen = p; else break; }
    return chosen;
  };
  const mk = (base: { t: number; equity: number } | null): PnlWindow | null => {
    if (!base || !(base.equity > 0) || !(current > 0)) return null;
    const pl = current - base.equity;
    return { pl: Math.round(pl * 100) / 100, pct: Math.round((pl / base.equity) * 10000) / 100, from: base.t, partial: false };
  };

  const windows = {
    day: mk(baselineAt(todayStart - 1)),                 // the last session recorded before today
    week: mk(baselineAt(nowSec - 7 * DAY)),
    month: mk(baselineAt(nowSec - 30 * DAY)),
    d90: mk(baselineAt(nowSec - 90 * DAY)),
    ytd: mk(baselineAt(yearStart)),
    all: mk(series.length ? series[0] : null),
  };
  const reason = series.length
    ? undefined
    : 'No recorded equity history for this account yet. A daily snapshot is written on every broker sync.';
  return { source: 'equity_snapshots', env, current, asOf: series.length ? nowSec : null, windows, series: withLivePoint(series, current, nowSec), reason };
}
