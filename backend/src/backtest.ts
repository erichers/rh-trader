import { snapshot } from './market/indicators.js';
import { evalRules } from './bots/engine.js';
import { refreshBars } from './brokers/index.js';
import { alpacaData } from './brokers/alpaca.js';
import { optionBars } from './brokers/options.js';
import { exec } from './db.js';

// ── Real historical option pricing (best-effort, by OCC symbol construction) ──
const _occBarsCache = new Map<string, any[]>();

function occSymbol(underlying: string, expISO: string, type: 'call' | 'put', strike: number): string {
  const [y, m, d] = expISO.split('-');
  const yymmdd = `${y.slice(2)}${m}${d}`;
  const cp = type === 'call' ? 'C' : 'P';
  const strk = String(Math.round(strike * 1000)).padStart(8, '0');
  return `${underlying.toUpperCase()}${yymmdd}${cp}${strk}`;
}

/** A standard expiration Friday at/after a target date. monthly = 3rd Friday. */
function pickExpiration(afterMs: number, pref: string): string {
  if (/^\d{4}-\d{2}-\d{2}$/.test(pref)) return pref; // explicit LEAPS date
  const d = new Date(afterMs + 5 * 864e5); // a few days of buffer past exit
  if (pref === 'monthly') {
    for (let mo = 0; mo < 4; mo++) {
      const base = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + mo, 1));
      // 3rd Friday
      let fridays = 0; let day = new Date(base);
      while (day.getUTCMonth() === base.getUTCMonth()) {
        if (day.getUTCDay() === 5) { fridays++; if (fridays === 3) break; }
        day = new Date(day.getTime() + 864e5);
      }
      if (day.getTime() >= d.getTime()) return day.toISOString().slice(0, 10);
    }
  }
  // weekly: next Friday on/after the buffer date
  const wd = new Date(d);
  while (wd.getUTCDay() !== 5) wd.setUTCDate(wd.getUTCDate() + 1);
  return wd.toISOString().slice(0, 10);
}

function roundStrike(price: number): number {
  const step = price >= 100 ? 5 : price >= 25 ? 1 : 0.5;
  return Math.round(price / step) * step;
}

async function occBars(sym: string, start: string, end: string): Promise<any[]> {
  const key = `${sym}|${start}|${end}`;
  if (_occBarsCache.has(key)) return _occBarsCache.get(key)!;
  const bars = await optionBars(sym, start, end).catch(() => [] as any[]);
  _occBarsCache.set(key, bars);
  return bars;
}

/** Real option entry/exit price for a trade. Returns null if data unavailable. */
async function realOptionTrade(
  underlying: string, type: 'call' | 'put', strikeTarget: string, expPref: string,
  entrySpot: number, entryISO: string, exitISO: string,
): Promise<{ entry: number; exit: number; ret: number } | null> {
  const factor = strikeTarget === 'otm' ? (type === 'call' ? 1.04 : 0.96)
    : strikeTarget === 'itm' ? (type === 'call' ? 0.97 : 1.03) : 1;
  const strike = roundStrike(entrySpot * factor);
  const exp = pickExpiration(Date.parse(exitISO), expPref);
  const sym = occSymbol(underlying, exp, type, strike);
  const bars = await occBars(sym, entryISO, new Date(Date.parse(exitISO) + 2 * 864e5).toISOString().slice(0, 10));
  if (bars.length < 2) return null;
  // Require a bar within ~1.5 calendar days (≈ 1 trading day incl. a weekend gap) of
  // the target — a price snapped from 4 days away isn't an honest fill for that date.
  const at = (iso: string) => {
    const ms = Date.parse(iso);
    let best: any = null, bd = Infinity;
    for (const b of bars) { const d = Math.abs(Date.parse(b.t) - ms); if (d < bd) { bd = d; best = b; } }
    return best && bd <= 1.5 * 864e5 ? Number(best.c) : null;
  };
  const e = at(entryISO), x = at(exitISO);
  if (e == null || x == null || e <= 0) return null;
  return { entry: e, exit: x, ret: ((x - e) / e) * 100 };
}

// Modeled long-option leverage by strike target (premium leverage proxy), plus
// per-day theta drag. Options backtests are MODELED from the underlying move —
// not real historical option chain prices. Honest approximation.
const OPT_LEVERAGE: Record<string, number> = { otm: 9, atm: 6, itm: 3 };
const THETA_PER_DAY: Record<string, number> = { weekly: 0.045, monthly: 0.015, leaps: 0.004 };

const isLeapsExp = (e: string) => e === 'leaps' || /^\d{4}-\d{2}-\d{2}$/.test(e);
function thetaFor(expiration: string): number {
  if (isLeapsExp(expiration)) return THETA_PER_DAY.leaps;
  return THETA_PER_DAY[expiration] ?? THETA_PER_DAY.weekly;
}

export type BacktestParams = {
  days?: number;
  from?: string; // ISO date (inclusive) — overrides days when set
  to?: string;   // ISO date (inclusive)
  takeProfitPct?: number; // underlying move TP
  stopLossPct?: number;
  trailingStopPct?: number; // exit when favorable move retraces this much from its peak
  maxHoldBars?: number;
  stakeUsd?: number;
  realOptions?: boolean; // price option trades with real historical option bars (best-effort)
  dte?: number; // concrete days-to-expiry (QuickBots) → DTE-aware leverage/theta + hold cap
};

export type Trade = {
  entryIdx: number;
  exitIdx: number;
  entry: number;
  exit: number;
  bars: number;
  underlyingRet: number; // %
  ret: number; // % return on the instrument (option-modeled or equity)
  multiple: number; // 1 + ret/100 (e.g. 3.0 = 3x)
  reason: string;
  entry_date?: string;
  exit_date?: string;
  side?: 'buy' | 'sell';
  source?: 'real' | 'modeled'; // option pricing source
  option_entry?: number;
  option_exit?: number;
};

export type BacktestResult = {
  symbol: string;
  asset_class: string;
  days: number;
  bars: number;
  trades: Trade[];
  metrics: {
    num_trades: number;
    wins: number;
    win_rate: number;
    total_return_pct: number; // sum of per-trade returns on fixed stake
    avg_return_pct: number;
    best_trade_pct: number;
    worst_trade_pct: number;
    best_multiple: number;
    trades_2x: number;
    trades_5x: number;
    max_drawdown_pct: number;
    end_equity: number;
    start_equity: number;
  };
  equity_curve: number[];
  equity_dates: number[]; // epoch ms aligned to equity_curve points
  series: { t: number; c: number }[]; // dated price series for charting
  from?: string;
  to?: string;
  notes: string;
};

function optionReturn(
  underlyingRetPct: number,
  optionType: 'call' | 'put',
  strikeTarget: string,
  expiration: string,
  barsHeld: number,
  dte?: number,
): number {
  // Short-DTE options have far higher gamma leverage AND far faster theta decay than a
  // standard weekly. When a concrete DTE is given (QuickBots), scale both by 1/√DTE so
  // a 1-day ATM call shows the real "huge convexity, brutal decay" profile vs a 7-day.
  let lev = OPT_LEVERAGE[strikeTarget] ?? OPT_LEVERAGE.atm;
  let thetaPerDay = thetaFor(expiration);
  if (dte && dte > 0) {
    const f = Math.sqrt(7 / dte); // 1d→2.65, 7d→1.0
    lev = lev * f;
    thetaPerDay = 0.06 * f; // ~0.16/day at 1-DTE down to ~0.06/day at 7-DTE
  }
  const theta = thetaPerDay * Math.max(1, barsHeld);
  // Calls profit on up moves, puts profit on down moves.
  const directional = optionType === 'put' ? -underlyingRetPct : underlyingRetPct;
  const raw = (directional / 100) * lev - theta; // fraction
  return Math.max(-1, raw) * 100; // floor at -100% (premium lost), as %
}

export async function backtest(
  opts: {
    symbol: string;
    rules: any;
    action: any;
    asset_class?: string;
  },
  params: BacktestParams = {},
): Promise<BacktestResult> {
  const days = params.days ?? 90;
  const stake = params.stakeUsd ?? 1000;
  const expPref0 = opts.action?.expiration || 'weekly';
  // A concrete DTE caps the hold to that many trading bars (a 2-day option can't be held 10).
  const maxHold = params.maxHoldBars ?? (params.dte && params.dte > 0 ? Math.max(1, params.dte)
    : isLeapsExp(expPref0) ? 60 : (opts.action?._timeframe && opts.action._timeframe !== '1Day' ? 3 : 10));
  const tp = params.takeProfitPct ?? null;
  const sl = params.stopLossPct ?? null;
  const trail = params.trailingStopPct ?? null;

  // Pull raw daily bars (with timestamps). Fetch wide so indicator warmup is
  // always covered even when a narrow from/to window is requested.
  const fromMs = params.from ? Date.parse(params.from) : null;
  const toMs = params.to ? Date.parse(params.to) + 86_400_000 : null; // inclusive end-of-day
  const fetchN = fromMs ? Math.min(700, Math.ceil((Date.now() - fromMs) / 86_400_000) + 90) : Math.max(days + 80, 140);
  const raw = await alpacaData.barsRaw(opts.symbol, '1Day', fetchN).catch(() => [] as any[]);
  const closes: number[] = raw.map((b: any) => Number(b.c));
  const times: number[] = raw.map((b: any) => Date.parse(b.t));
  const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10);

  // Window: [windowStart, windowEnd] is what we report; evaluation can start
  // earlier only for indicator warmup but trades are counted within the window.
  const warmup = 55;
  let windowStart = fromMs != null ? times.findIndex((t) => t >= fromMs) : Math.max(0, closes.length - days);
  if (windowStart < 0) windowStart = Math.max(0, closes.length - days);
  let windowEnd = toMs != null ? (() => { let e = -1; for (let i = 0; i < times.length; i++) if (times[i] <= toMs) e = i; return e; })() : closes.length - 1;
  if (windowEnd < 0) windowEnd = closes.length - 1;
  const evalStart = Math.max(warmup, windowStart);

  const trades: Trade[] = [];
  const isOption = (opts.asset_class || 'equity') === 'option';
  const optionType = (opts.action?.option_type as 'call' | 'put') || 'call';
  const strikeTarget = opts.action?.strike_target || 'atm';
  const expiration = opts.action?.expiration || 'weekly';

  let open: { idx: number; price: number; peakFav: number } | null = null;
  for (let i = evalStart; i <= windowEnd; i++) {
    const window = closes.slice(0, i + 1);
    const snap = snapshot(window);
    const ev = evalRules(opts.rules, snap);
    const price = closes[i];

    if (open) {
      const barsHeld = i - open.idx;
      const uret = ((price - open.price) / open.price) * 100;
      const favorable = isOption ? (optionType === 'put' ? -uret : uret) : uret;
      open.peakFav = Math.max(open.peakFav, favorable);
      let exit = false;
      let reason = '';
      if (tp != null && favorable >= tp) { exit = true; reason = 'take-profit'; }
      else if (sl != null && favorable <= -sl) { exit = true; reason = 'stop-loss'; }
      else if (trail != null && open.peakFav > 0 && favorable <= open.peakFav - trail) { exit = true; reason = 'trailing-stop'; }
      else if (barsHeld >= maxHold) { exit = true; reason = 'max-hold'; }
      else if (ev.fired && ev.side === 'sell' && !isOption) { exit = true; reason = 'exit-signal'; }
      else if (i === windowEnd) { exit = true; reason = 'window-end'; }
      if (exit) {
        // Options book a ~4% round-trip spread cost (matches the QuickBot engine) so modeled
        // option backtests aren't inflated by a frictionless fill assumption. Floor at −100%.
        const gross = isOption ? optionReturn(uret, optionType, strikeTarget, expiration, barsHeld, params.dte) : uret;
        const ret = isOption ? Math.max(-100, gross - 4) : gross;
        trades.push({
          entryIdx: open.idx, exitIdx: i, entry: round(open.price, 2), exit: round(price, 2), bars: barsHeld,
          underlyingRet: round(uret), ret: round(ret), multiple: round(1 + ret / 100, 3), reason,
          entry_date: iso(times[open.idx]), exit_date: iso(times[i]),
          side: isOption ? (optionType === 'put' ? 'sell' : 'buy') : 'buy',
        });
        open = null;
      }
    }
    if (!open && ev.fired && i < windowEnd) {
      // Options: only enter when the signal direction matches the option type —
      // a call needs a bullish (buy) signal, a put needs a bearish (sell) signal.
      const entryOk = isOption ? (optionType === 'put' ? ev.side === 'sell' : ev.side === 'buy') : ev.side === 'buy';
      if (entryOk) open = { idx: i, price, peakFav: 0 };
    }
  }

  // Optional: replace modeled option returns with REAL historical option prices.
  let realPriced = 0;
  if (isOption && params.realOptions) {
    for (const tr of trades) {
      const real = await realOptionTrade(opts.symbol, optionType, strikeTarget, expiration, tr.entry, tr.entry_date!, tr.exit_date!);
      if (real) {
        tr.option_entry = round(real.entry, 2); tr.option_exit = round(real.exit, 2);
        const realNet = Math.max(-100, real.ret - 4); // same round-trip spread cost on real fills
        tr.ret = round(realNet); tr.multiple = round(1 + realNet / 100, 3); tr.source = 'real'; realPriced++;
      } else { tr.source = 'modeled'; }
    }
  } else if (isOption) {
    for (const tr of trades) tr.source = 'modeled';
  }

  // Metrics on fixed stake (non-compounding) + dated equity curve.
  let equity = stake;
  const curve: number[] = [stake];
  const equityDates: number[] = [times[windowStart] ?? Date.now()];
  let peak = stake;
  let maxDD = 0;
  // Compounded account multiple — "what would this have done to the WHOLE account"
  // if you reinvested everything each trade (matches the high-risk campaign intent).
  let compounded = 1;
  for (const t of trades) {
    const tr = Math.max(-100, t.ret); // a single trade can't lose more than the deployed stake
    // Fixed-stake: cumulative P/L (no resurrection floor) so total_return == Σ(ret) and the
    // drawdown is the real peak-to-trough. account_multiple (compounded) stays floored at 0.
    equity = equity + stake * (tr / 100);
    curve.push(round(equity, 2));
    equityDates.push(times[t.exitIdx] ?? Date.now());
    peak = Math.max(peak, equity); // ≥ stake > 0
    maxDD = Math.min(maxDD, ((equity - peak) / peak) * 100);
    compounded *= Math.max(0, 1 + tr / 100);
  }

  // Price series for the chart (downsample to ~260 pts).
  const sliceStart = windowStart, sliceEnd = windowEnd;
  const rawSeries: { t: number; c: number }[] = [];
  for (let i = sliceStart; i <= sliceEnd; i++) rawSeries.push({ t: times[i], c: round(closes[i], 2) });
  const step = Math.max(1, Math.ceil(rawSeries.length / 260));
  const series = rawSeries.filter((_, i) => i % step === 0 || i === rawSeries.length - 1);
  const rets = trades.map((t) => t.ret);
  const wins = rets.filter((r) => r > 0).length;
  const multiples = trades.map((t) => t.multiple);
  // Win-rate excludes forced 'window-end' liquidations (not a strategy decision).
  const decisive = trades.filter((t) => t.reason !== 'window-end');
  const decisiveWins = decisive.filter((t) => t.ret > 0).length;
  const metrics = {
    num_trades: trades.length,
    wins,
    win_rate: decisive.length ? round((decisiveWins / decisive.length) * 100, 1) : 0,
    total_return_pct: round(((equity - stake) / stake) * 100, 1),
    avg_return_pct: rets.length ? round(rets.reduce((a, b) => a + b, 0) / rets.length, 2) : 0,
    best_trade_pct: rets.length ? round(Math.max(...rets), 1) : 0,
    worst_trade_pct: rets.length ? round(Math.min(...rets), 1) : 0,
    best_multiple: multiples.length ? round(Math.max(...multiples), 2) : 0,
    account_multiple: round(compounded, 2), // compounded over the window (e.g. 12.0 = 12x)
    trades_2x: multiples.filter((m) => m >= 2).length,
    trades_5x: multiples.filter((m) => m >= 5).length,
    max_drawdown_pct: round(maxDD, 1), // peak-to-trough of cumulative fixed-stake P/L
    end_equity: round(equity, 2),
    start_equity: stake,
    real_priced: realPriced,
    option_trades: isOption ? trades.length : 0,
  };

  return {
    symbol: opts.symbol,
    asset_class: opts.asset_class || 'equity',
    days,
    bars: Math.max(0, windowEnd - windowStart + 1),
    trades,
    metrics,
    equity_curve: curve,
    equity_dates: equityDates,
    series,
    from: times[windowStart] ? iso(times[windowStart]) : undefined,
    to: times[windowEnd] ? iso(times[windowEnd]) : undefined,
    notes: isOption
      ? (params.realOptions
        ? `Long-${optionType}: ${realPriced}/${trades.length} trades priced with REAL historical option bars (by OCC symbol); the rest fall back to modeled (leverage/theta) where Alpaca had no bars.`
        : `Modeled long-${optionType} returns from underlying moves (leverage ${OPT_LEVERAGE[strikeTarget] ?? 6}x ${strikeTarget}, theta ${(THETA_PER_DAY[expiration] ?? 0.045) * 100}%/day). Toggle "real option prices" for actual historical fills where available.`)
      : 'Equity long backtest on daily bars.',
  };
}

function parseJSON(v: any, d: any) {
  if (v == null) return d;
  if (typeof v === 'object') return v;
  try { return JSON.parse(v); } catch { return d; }
}

/** Backtest a stored bot and persist the result. */
export async function backtestBot(botRow: any, params: BacktestParams = {}): Promise<any> {
  const symbols: string[] = parseJSON(botRow.symbols, []);
  const rules = parseJSON(botRow.rules, {});
  const action = parseJSON(botRow.action, {});
  // QuickBots keep their triggers in action.plays (per-symbol, DTE-scaled) — the generic
  // rules-based backtest would see empty rules and honestly return 0 trades (or worse,
  // choke logging a 7-ticker basket). Route them to their own BS-repriced backtest.
  if (action?._quickbot) {
    const { backtestQuickbot } = await import('./quickbot.js');
    const sym = String(action._research || symbols[0] || 'QQQ').toUpperCase();
    const bt = await backtestQuickbot(sym, { days: Math.min(730, Math.max(90, params.days ?? 365)) });
    const best = bt.chosen[0] || bt.all[0];
    return {
      bot: botRow.name, quickbot: true, symbol: sym,
      note: `QuickBot — backtested with its own Black–Scholes engine on ${sym} (see the QuickBots tab for the full per-play grid).`,
      aggregate: best ? { metrics: best.metrics } : { metrics: null },
      chosen: bt.chosen.map((p) => ({ key: p.key, label: p.label, dir: p.dir, dte: p.dte, robust: p.robust, metrics: p.metrics })),
    };
  }
  const risk = parseJSON(botRow.risk, {});
  // Apply the bot's own exit constraints (set in the Add-Bot wizard).
  const merged: BacktestParams = {
    ...params,
    takeProfitPct: params.takeProfitPct ?? (Number(risk.take_profit_pct) || undefined),
    stopLossPct: params.stopLossPct ?? (Number(risk.stop_loss_pct) || undefined),
    trailingStopPct: params.trailingStopPct ?? (Number(risk.trailing_stop_pct) || undefined),
  };
  params = merged;
  const perSymbol: BacktestResult[] = [];
  for (const s of symbols.slice(0, 6)) {
    try {
      perSymbol.push(await backtest({ symbol: String(s).toUpperCase(), rules, action, asset_class: botRow.asset_class }, params));
    } catch { /* skip symbol */ }
  }
  // Aggregate across symbols.
  const agg = aggregate(perSymbol);
  await exec(
    `INSERT INTO backtests (bot_id, name, symbol, asset_class, days, params, metrics, trades, equity_curve)
     VALUES (:bid,:name,:sym,:ac,:days,CAST(:p AS JSON),CAST(:m AS JSON),CAST(:t AS JSON),CAST(:e AS JSON))`,
    {
      bid: botRow.id, name: botRow.name, sym: symbols.join(',').slice(0, 32), ac: botRow.asset_class,
      days: params.days ?? 90, p: JSON.stringify(params), m: JSON.stringify(agg.metrics),
      t: JSON.stringify(agg.trades.slice(0, 50)), e: JSON.stringify(agg.equity_curve),
    },
  );
  return { bot: botRow.name, perSymbol, aggregate: agg };
}

/**
 * Badges from a backtest aggregate + current-regime fit. Performance multiples are
 * GATED so a single fluke can't earn a "100×" badge: they need a minimum number of
 * trades, and (for options) require trades priced from REAL historical chains — not
 * the modeled leverage approximation. Honest by construction.
 */
export function badgesFor(metrics: any, fit: { badge: string }, opts: { isOption?: boolean; realPriced?: number } = {}): string[] {
  const b: string[] = [];
  const am = Number(metrics?.account_multiple ?? 1);
  const trades = Number(metrics?.num_trades ?? 0);
  // A multiple badge needs a real sample, and options must be real-priced (not modeled).
  const sampleOk = trades >= 8;
  const optionOk = !opts.isOption || Number(opts.realPriced ?? 0) >= Math.max(1, Math.ceil(trades * 0.6));
  const earned = sampleOk && optionOk;
  if (earned) {
    if (am >= 100) b.push('100x');
    else if (am >= 10) b.push('10x');
    else if (am >= 5) b.push('5x');
    else if (am >= 2) b.push('2x');
  } else if (am >= 2) {
    b.push(opts.isOption && !optionOk ? 'modeled-only' : 'small-sample');
  }
  // 'profitable'/'high-win' on a MODELED-only option bot would still rest on the
  // leverage approximation — gate them on real-priced fills too.
  if (trades >= 5 && optionOk && Number(metrics?.total_return_pct ?? 0) > 0) b.push('profitable');
  if (trades >= 8 && optionOk && Number(metrics?.win_rate ?? 0) >= 60) b.push('high-win');
  b.push(fit.badge); // seasonal-fit | regime-neutral | regime-caution
  return b;
}

/**
 * Scan EVERY bot over the window (default 6 months), price option bots with real
 * historical option bars, rank by compounded account multiple, and tag each with
 * performance + current-regime badges. This is what powers "find the bots that
 * would have 10x–100x'd my account".
 */
export async function scanStrategies(opts: { days?: number } = {}): Promise<any> {
  const { q, getTradingEnv } = await import('./db.js');
  const { seasonalFit } = await import('./market/regime.js');
  const days = opts.days ?? 182;
  const env = await getTradingEnv();
  const bots = await q<any>('SELECT * FROM bots WHERE env=:env ORDER BY id ASC', { env });
  const rows: any[] = [];
  for (const bot of bots) {
    try {
      const isOption = bot.asset_class === 'option';
      const res = await backtestBot(bot, { days, realOptions: isOption });
      const m = res.aggregate.metrics;
      const fit = seasonalFit(bot);
      const realPriced = (res.perSymbol || []).reduce((s: number, r: any) => s + Number(r.metrics?.real_priced ?? 0), 0);
      rows.push({
        bot_id: bot.id, name: bot.name,
        symbols: parseJSON(bot.symbols, []), asset_class: bot.asset_class,
        enabled: !!bot.enabled, mode: bot.mode,
        metrics: m,
        account_multiple: m.account_multiple ?? 1,
        total_return_pct: m.total_return_pct ?? 0,
        win_rate: m.win_rate ?? 0,
        num_trades: m.num_trades ?? 0,
        best_multiple: m.best_multiple ?? 0,
        real_priced: realPriced,
        modeled: isOption && realPriced < (m.num_trades ?? 0),
        seasonal: fit,
        badges: badgesFor(m, fit, { isOption, realPriced }),
      });
    } catch (e: any) {
      rows.push({ bot_id: bot.id, name: bot.name, error: e?.message || String(e), badges: [] });
    }
  }
  // Rank REAL-priced/equity results above modeled-only option results — a modeled
  // multiple rests on the leverage approximation and shouldn't outrank a real one.
  rows.sort((a, b) => (Number(!!a.modeled) - Number(!!b.modeled)) || ((b.account_multiple || 0) - (a.account_multiple || 0)));
  return {
    days,
    as_of: new Date().toISOString().slice(0, 10),
    count: rows.length,
    winners_10x: rows.filter((r) => (r.account_multiple || 0) >= 10).length,
    seasonal_fit: rows.filter((r) => r.seasonal?.badge === 'seasonal-fit').length,
    results: rows,
  };
}

function aggregate(results: BacktestResult[]) {
  const allTrades = results.flatMap((r) => r.trades.map((t) => ({ ...t, symbol: r.symbol })))
    .sort((a, b) => ((a as any).exit_date || '').localeCompare((b as any).exit_date || ''));
  const stake = 1000;
  let equity = stake;
  const curve = [stake];
  let peak = stake, maxDD = 0;
  let compounded = 1;
  for (const t of allTrades) {
    const tr = Math.max(-100, t.ret);
    equity = equity + stake * (tr / 100); // fixed-stake cumulative P/L (no floor)
    curve.push(round(equity, 2));
    peak = Math.max(peak, equity);
    maxDD = Math.min(maxDD, ((equity - peak) / peak) * 100);
    compounded *= Math.max(0, 1 + tr / 100);
  }
  const rets = allTrades.map((t) => t.ret);
  const mult = allTrades.map((t) => t.multiple);
  // Win-rate excludes forced window-end liquidations (match backtest()'s honest definition).
  const decisive = allTrades.filter((t: any) => t.reason !== 'window-end');
  const decisiveWins = decisive.filter((t) => t.ret > 0).length;
  return {
    metrics: {
      symbols: results.map((r) => r.symbol),
      num_trades: allTrades.length,
      win_rate: decisive.length ? round((decisiveWins / decisive.length) * 100, 1) : 0,
      total_return_pct: round(((equity - stake) / stake) * 100, 1),
      avg_return_pct: rets.length ? round(rets.reduce((a, b) => a + b, 0) / rets.length, 2) : 0,
      best_multiple: mult.length ? round(Math.max(...mult), 2) : 0,
      account_multiple: round(compounded, 2),
      trades_2x: mult.filter((m) => m >= 2).length,
      trades_5x: mult.filter((m) => m >= 5).length,
      max_drawdown_pct: round(maxDD, 1),
    },
    trades: allTrades,
    equity_curve: curve,
  };
}

function round(n: number, d = 1): number {
  const f = 10 ** d;
  return Math.round(n * f) / f;
}
