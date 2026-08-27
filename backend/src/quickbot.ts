import { snapshot } from './market/indicators.js';
import { dteToExpiration } from './market/expirations.js';
import { evalRules, reentryGate, claimEntrySlot, releaseEntrySlot } from './bots/engine.js';
import { exitReason } from './risk/exitpolicy.js';
import { alpacaData } from './brokers/alpaca.js';
import { q, exec, getTradingEnv, audit } from './db.js';
import { executeDraft } from './execute.js';
import { sizeDraft } from './risk/sizing.js';
import type { OrderDraft } from './risk/engine.js';
import type { TradingEnv } from './config.js';

/**
 * QUICKBOTS — single-underlying (or tight-basket) short-DTE options bots that trade
 * calls AND puts based on signals, with risk that scales by days-to-expiry. The default
 * strategy for each is chosen EMPIRICALLY from a 1-year backtest over a grid of
 * signal × direction × DTE combinations (see backtestQuickbot). Everything here is
 * modeled from REAL underlying price action — exact historical short-DTE option fills
 * aren't sourceable, so option P/L is a documented BSM-style approximation (high gamma
 * leverage + fast theta, both scaling by 1/√DTE). Honest by construction; labeled as
 * modeled wherever shown.
 */

// DTE risk bands. tp/sl/trail are % of the OPTION premium (matching the live monitor).
// max_position_usd must fit at least ONE real ATM contract — a mega-cap ATM option is
// premium×100 ≈ $400–$1600 depending on DTE/price, so caps too low would veto every
// 1-lot. Shorter DTE = tighter stop + smaller size (fast theta); longer = more room/size.
// These are DEFAULTS for the ~$100k paper account; size down via per-bot override for a
// small live account.
// ASYMMETRIC "small losses, big wins" profile (positive skew). The edge is convexity, not hit
// rate: cut losers at a fixed, SMALL stop and NEVER cap the winners — let them run on a trailing
// stop. tp=0 disables the take-profit so a winner rides until it gives back `trail` from its peak
// (or expiry). Shorter DTE = tighter stop + smaller size (fast theta/noise); longer = more room.
// Result is a low-win-rate / high-expectancy payoff: many small losses, occasional huge wins.
export const DTE_BANDS: Record<number, { tp: number; sl: number; trail: number; max_position_usd: number; qty: number }> = {
  1: { tp: 0, sl: 28, trail: 35, max_position_usd: 700, qty: 1 },
  2: { tp: 0, sl: 30, trail: 40, max_position_usd: 900, qty: 1 },
  3: { tp: 0, sl: 33, trail: 45, max_position_usd: 1100, qty: 1 },
  4: { tp: 0, sl: 36, trail: 52, max_position_usd: 1400, qty: 1 },
  7: { tp: 0, sl: 42, trail: 60, max_position_usd: 2000, qty: 1 },
};
export const QUICK_DTES = [1, 2, 3, 4, 7]; // DTEs searched/traded (1 = highest-variance, gamma-heavy)
// The full tradable universe: Mag-7 single names + the two big index ETFs.
export const MAG7 = ['AAPL', 'MSFT', 'GOOGL', 'AMZN', 'NVDA', 'META', 'TSLA'];
export const UNIVERSE = [...MAG7, 'SPY', 'QQQ'];

// Candidate entry signals. Bull → buy a CALL, bear → buy a PUT. Each is a real rule set
// the generic engine already understands (so live eval = backtest eval, no drift).
type Cand = { key: string; label: string; dir: 'call' | 'put'; rules: any; explain: string };
const CANDIDATES: Cand[] = [
  { key: 'momo_up', label: 'Up-momentum (classic, no filter)', dir: 'call', rules: {"change_above": 0.8}, explain: 'Buys calls on any up day above the threshold — the most reactive momentum entry; the proven baseline.' },
  { key: 'breakout_up', label: 'Breakout in uptrend (classic)', dir: 'call', rules: {"breakout_high": true, "price_above_sma20": true, "require_all": true}, explain: 'Close above the prior 20-day high while above SMA20 — clean trend breakout.' },
  { key: 'rsi_dip', label: 'RSI oversold bounce (classic)', dir: 'call', rules: {"rsi_below": 32}, explain: 'Counter-trend oversold bounce; higher variance, baseline for comparison.' },
  { key: 'breakdown_dn', label: 'Breakdown in downtrend (classic)', dir: 'put', rules: {"breakdown_low": true, "price_below_sma20": true, "require_all": true}, explain: 'New 20-day low below SMA20 — clean trend breakdown for puts.' },
  { key: 'rsi_hot', label: 'RSI overbought fade (classic)', dir: 'put', rules: {"rsi_above": 70}, explain: 'Counter-trend overbought fade; baseline put for comparison.' },
  { key: 'trend_thrust_call', label: 'Trend Thrust Call', dir: 'call', rules: {"change_above": 1.2, "price_above_sma20": true, "above_ema50": true, "require_all": true}, explain: 'A 1.2%+ up-thrust inside a dual SMA20/EMA50 uptrend usually extends 2-3 days, letting near-ATM gamma outrun theta.' },
  { key: 'five_day_momo_call', label: '5-Day Momentum Rider', dir: 'call', rules: {"mom5_above": 4, "price_above_sma20": true, "near_high20": 3, "require_all": true}, explain: 'Leadership names up >4% over 5 days and within 3% of the 20-day high keep running, the highest-persistence mega-cap continuation signal.' },
  { key: 'accel_streak_uptrend_call', label: 'Streak Continuation Call (4-up in trend)', dir: 'call', rules: {"consec_up": 4, "above_ema50": true, "price_above_sma20": true, "require_all": true}, explain: 'Four straight up-closes above EMA50/SMA20 mark a low-pullback grind that frequently extends into a 5-8 day leg.' },
  { key: 'accel_dual_momentum_call', label: 'Dual-Horizon Momentum Call (5d+10d)', dir: 'call', rules: {"mom5_above": 4, "mom10_above": 7, "above_ema50": true, "require_all": true}, explain: 'Requiring positive-and-accelerating 5d (>4%) and 10d (>7%) momentum yields fewer, higher-conviction entries that ride established trends.' },
  { key: 'accel_rsi_cross60_call', label: 'RSI Cross-Above 60 Strength Call', dir: 'call', rules: {"rsi_cross_above": 60, "price_above_sma20": true, "require_all": true}, explain: 'RSI crossing up through 60 in an uptrend fires once at the ignition of genuine strength, timing calls to the start of acceleration.' },
  { key: 'accel_macd_flip_near_high_call', label: 'MACD Flip Near Highs Call', dir: 'call', rules: {"macd_positive": true, "near_high20": 2, "above_ema50": true, "require_all": true}, explain: 'A fresh MACD histogram flip while coiled within 2% of the 20-day high above EMA50 front-runs the breakout into convex upside.' },
  { key: 'donchian_breakout_trend', label: '20-Day Breakout (Trend-Gated)', dir: 'call', rules: {"breakout_high": true, "above_ema50": true, "price_above_sma20": true, "require_all": true}, explain: 'A fresh 20-day-high close inside a dual uptrend draws in stops and breakout buyers, the day-1 continuation short-DTE calls monetize.' },
  { key: 'vol_expand_breakout_call', label: 'Vol-Expansion Breakout Call', dir: 'call', rules: {"breakout_high": true, "vol_expand": 1.5, "near_high20": 2, "above_ema50": true, "require_all": true}, explain: 'A 20-day-high close arriving on a >1.5x-vol expansion isolates true momentum ignition, not quiet drift through the high.' },
  { key: 'vol_expand_momo_burst_call', label: 'Vol-Expansion Momentum Burst Call', dir: 'call', rules: {"change_above": 2.5, "vol_expand": 1.8, "mom5_above": 3, "price_above_sma20": true, "require_all": true}, explain: 'A >2.5% pop that is a true >1.8x-vol expansion with positive 5-day momentum catches gap-and-go catalyst days that follow through overnight.' },
  { key: 'dip_buy_near_highs_call', label: 'Buy-the-Dip Near Highs', dir: 'call', rules: {"rsi_below": 42, "above_ema50": true, "near_high20": 4, "require_all": true}, explain: 'A shallow RSI<42 dip in a name still above EMA50 and within 4% of its 20-day high is a winner\'s breather that resumes.' },
  { key: 'rsi_turn_up_call', label: 'RSI Turn-Up Off the Dip', dir: 'call', rules: {"rsi_cross_above": 38, "above_ema50": true, "price_above_sma20": true, "require_all": true}, explain: 'Entering when RSI crosses back up through 38 inside an uptrend buys the bounce already underway, minimizing theta bleed before the move.' },
  { key: 'bollinger_break_uptrend_dip', label: 'Bollinger Break Dip-in-Uptrend', dir: 'call', rules: {"bollinger_lower": true, "rsi_below": 35, "above_ema50": true, "require_all": true}, explain: 'Piercing the lower band with RSI<35 while still above EMA50 is a shakeout in an intact uptrend that snaps back to the mid-band fastest. (high-variance counter-trend)' },
  { key: 'capitulation_flush_rebound', label: 'Capitulation Flush Rebound', dir: 'call', rules: {"change_below": -4, "rsi_below": 30, "vol_expand": 2, "require_all": true}, explain: 'A >4% single-day flush that is a >2x-vol outlier leaving RSI<30 rarely persists in mega-caps; the reflex V-bounce repays a short hold. (high-variance counter-trend)' },
  { key: 'oversold_rsi_cross_snapback', label: 'Oversold RSI Cross-Up Snapback', dir: 'call', rules: {"rsi_cross_above": 30, "vol_expand": 1.3, "require_all": true}, explain: 'Waiting for RSI to cross up through 30 on a vol-expansion bar confirms the turn before paying premium, the cleanest non-knife-catch bounce. (high-variance counter-trend)' },
  { key: 'put_breakdown_stacked_trend', label: 'Stacked-Downtrend 20d Breakdown', dir: 'put', rules: {"breakdown_low": true, "price_below_sma20": true, "below_ema50": true, "require_all": true}, explain: 'A new 20-day low while already below both SMA20 and EMA50 is the start of a sustained leg down, filtering out dip-in-bull head-fakes.' },
  { key: 'put_vol_expansion_thrust', label: 'Volatility-Expansion Down Thrust', dir: 'put', rules: {"change_below": -1.8, "vol_expand": 1.8, "price_below_sma20": true, "require_all": true}, explain: 'An outsized vol-confirmed down day below SMA20 tends to cluster (vol begets vol), giving short-DTE puts explosive gamma plus an IV pop.' },
  { key: 'put_momentum_decay_consec', label: 'Persistent Momentum Decay (5d+streak)', dir: 'put', rules: {"mom5_below": -4, "consec_down": 3, "below_ema50": true, "require_all": true}, explain: 'A 3-day down streak with a -4% week below EMA50 is a tape that has lost its bid; the entrenched slide does the work, not a one-day pop.' },
  { key: 'put_overbought_rsi_rolldown', label: 'Overbought RSI Roll-Down Fade', dir: 'put', rules: {"rsi_cross_below": 70, "vol_expand": 1.3, "require_all": true}, explain: 'Buying puts the day RSI crosses down through 70 on an expanding-range bar enters as the rally actually breaks, far better timing than a static overbought read. (high-variance counter-trend)' },
  { key: 'spyqqq_breakdown_hedge_put', label: 'Index Breakdown Hedge Put', dir: 'put', rules: {"breakdown_low": true, "below_ema50": true, "vol_expand": 1.5, "require_all": true}, explain: 'A vol-expansion 20-day-low break below EMA50 cascades fast (\'stairs up, elevator down\'), hedging the bullish book on shock days for 3-10x.' },
];

// Tweakable numeric thresholds per rule key (for the UI sliders/inputs) + how to read them.
export const PARAM_META: Record<string, { label: string; min: number; max: number; step: number; hint: string }> = {
  rsi_below: { label: 'RSI oversold below', min: 10, max: 50, step: 1, hint: 'Lower = deeper oversold, fewer signals (25–35 typical).' },
  rsi_above: { label: 'RSI overbought above', min: 50, max: 90, step: 1, hint: 'Higher = more extreme, rarer (68–75 typical).' },
  change_above: { label: 'Up-day % threshold', min: 0.3, max: 3, step: 0.1, hint: 'Higher = fewer, stronger momentum signals (0.8–1.5 typical).' },
  change_below: { label: 'Down-day % threshold', min: -3, max: -0.3, step: 0.1, hint: 'More negative = stronger down move required (−0.8 to −1.5 typical).' },
  mom5_above: { label: '5-day momentum > %', min: 1, max: 20, step: 0.5, hint: 'Higher = stronger 1-week trend required (3–8 typical).' },
  mom5_below: { label: '5-day momentum < %', min: -20, max: -1, step: 0.5, hint: 'More negative = stronger 1-week downtrend (−3 to −8 typical).' },
  mom10_above: { label: '10-day momentum > %', min: 2, max: 30, step: 0.5, hint: 'Higher = stronger 2-week trend (5–12 typical).' },
  mom10_below: { label: '10-day momentum < %', min: -30, max: -2, step: 0.5, hint: 'More negative = stronger 2-week downtrend.' },
  consec_up: { label: 'Consecutive up days', min: 2, max: 6, step: 1, hint: 'More = rarer, stronger streak (2–4 typical).' },
  consec_down: { label: 'Consecutive down days', min: 2, max: 6, step: 1, hint: 'More = rarer, deeper pullback (2–4 typical).' },
  near_high20: { label: 'Within % of 20-day high', min: 0.5, max: 8, step: 0.5, hint: 'Smaller = closer to highs / stronger (1–3 typical).' },
  near_low20: { label: 'Within % of 20-day low', min: 0.5, max: 8, step: 0.5, hint: 'Smaller = closer to lows.' },
  rsi_cross_above: { label: 'RSI crosses up through', min: 30, max: 70, step: 1, hint: 'Momentum-turn level (50–60 typical).' },
  rsi_cross_below: { label: 'RSI crosses down through', min: 30, max: 70, step: 1, hint: 'Momentum-roll level (40–50 typical).' },
  vol_expand: { label: 'Move ≥ ×normal vol', min: 1, max: 3, step: 0.1, hint: 'Higher = only the biggest moves (1.3–2.0 typical).' },
};

// ── Black–Scholes repricing along the REAL underlying path ─────────────────────
// Rather than approximate leverage/theta, we price the actual ATM contract with BSM at
// entry and re-price it each bar as spot moves and time decays. This captures BOTH the
// convex gamma upside on a breakout AND the real theta bleed when the move doesn't come
// — the true short-DTE profile. σ = the underlying's own realized vol at entry (so the
// model adapts per symbol/regime). r≈0. Modeled (no real historical short-DTE fills
// exist to source), but a faithful, standard pricing — used to RANK strategies.
function normCdf(x: number): number {
  // Abramowitz–Stegun erf approximation.
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989422804014327 * Math.exp(-x * x / 2);
  let p = d * t * (0.31938153 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  return x >= 0 ? 1 - p : p;
}
function bsPrice(type: 'call' | 'put', S: number, K: number, Tyears: number, sigma: number): number {
  if (Tyears <= 0 || sigma <= 0) return Math.max(0, type === 'call' ? S - K : K - S); // intrinsic at expiry
  const v = sigma * Math.sqrt(Tyears);
  const d1 = (Math.log(S / K) + (sigma * sigma / 2) * Tyears) / v;
  const d2 = d1 - v;
  return type === 'call' ? S * normCdf(d1) - K * normCdf(d2) : K * normCdf(-d2) - S * normCdf(-d1);
}

/** Annualized realized volatility from daily closes (last ~window bars). */
function realizedVol(closes: number[], window = 30): number {
  const n = closes.length;
  const rets: number[] = [];
  for (let i = Math.max(1, n - window); i < n; i++) {
    const a = closes[i - 1], b = closes[i];
    if (a > 0 && b > 0) rets.push(Math.log(b / a));
  }
  if (rets.length < 5) return 0.2;
  const mean = rets.reduce((s, r) => s + r, 0) / rets.length;
  const varr = rets.reduce((s, r) => s + (r - mean) ** 2, 0) / rets.length;
  return Math.sqrt(varr) * Math.sqrt(252);
}

export type PlayMetrics = {
  num_trades: number; win_rate: number; total_return_pct: number; avg_return_pct: number;
  profit_factor: number; best_multiple: number; max_drawdown_pct: number; expectancy_pct: number;
  // Position-sizing inputs (derived from the same per-trade returns; purely additive — they
  // do NOT change total_return/drawdown). avg_win/avg_loss are mean magnitudes of the
  // winning/losing trades; payoff_ratio = avg_win/avg_loss; kelly_fraction is the full-Kelly
  // bet size implied by (win_rate, payoff_ratio), floored at 0 (negative ⇒ no edge ⇒ don't bet).
  avg_win_pct: number; avg_loss_pct: number; payoff_ratio: number; kelly_fraction: number;
};
export type PlayResult = {
  key: string; label: string; dir: 'call' | 'put'; dte: number; rules: any;
  risk: { tp: number; sl: number; trail: number; max_position_usd: number; qty: number };
  metrics: PlayMetrics; trades: any[]; equity_curve: number[]; score: number;
  // Out-of-sample check: average return in the FIRST vs SECOND half of the window. A play
  // that only worked in one half is likely overfit; `robust` requires both halves positive.
  robust: boolean; oos: { h1: number; h2: number; h1n: number; h2n: number };
};

function r2(n: number, d = 2): number { const f = 10 ** d; return Math.round(n * f) / f; }

// Round-trip transaction cost as a % of premium (buy at ask, sell at bid). Short-DTE ATM
// options aren't free to trade — this haircut keeps the backtest honest and kills plays
// whose edge is just spread illusion. ~4% is conservative for liquid ETF/mega-cap weeklies.
const COST_PCT = 4;

/** Simulate ONE play (signal+direction+DTE) over precomputed snapshots. Exits on the
 *  option's own TP/SL/trailing-stop (premium %) or at DTE (expiry), like the live monitor. */
function simulatePlay(closes: number[], times: number[], snaps: any[], start: number, end: number,
  cand: Cand, dte: number, band: { tp: number; sl: number; trail: number }): { metrics: PlayMetrics; trades: any[]; equity_curve: number[] } {
  const stake = 1000;
  let equity = stake, peakEq = stake, maxDD = 0, compounded = 1;
  const curve = [stake];
  const trades: any[] = [];
  let open: { idx: number; price: number; peak: number; sigma: number; strike: number; prem0: number } | null = null;
  for (let i = start; i <= end; i++) {
    const snap = snaps[i];
    if (!snap) continue;
    const ev = evalRules(cand.rules, snap);
    const price = closes[i];
    if (open) {
      const held = i - open.idx;
      const uret = ((price - open.price) / open.price) * 100;
      // Reprice the SAME contract: spot=price now, time left shrinks by each trading day.
      const Tleft = Math.max(0, dte - held) / 252;
      const premNow = bsPrice(cand.dir, price, open.strike, Tleft, open.sigma);
      const oret = open.prem0 > 0 ? ((premNow - open.prem0) / open.prem0) * 100 : 0;
      open.peak = Math.max(open.peak, oret);
      // Exit ladder SHARED with the live monitor (risk/exitpolicy.ts): tp>0 cap (off by default),
      // small fixed stop, breakeven lock at +30% peak, and the ratcheting trail that tightens as
      // the win grows. Backtest and live must agree or the backtest numbers are lies.
      let reason = exitReason(oret, open.peak, band) || '';
      if (!reason && held >= dte) reason = 'expiry';
      if (!reason && i === end) reason = 'window-end';
      const exit = !!reason;
      if (exit) {
        // Stops trigger on the gross premium move; the REALIZED return books the spread cost.
        // Per-trade return is floored at −100% (you can't lose more than the premium on ONE
        // trade). FIXED-STAKE model: each trade independently risks $1k, P/L accumulates
        // (no account "resurrection" floor) so total_return == Σ(per-trade ret) and the
        // drawdown is the real peak-to-trough of cumulative fixed-stake P/L.
        const net = Math.max(-100, oret - COST_PCT);
        equity = equity + stake * (net / 100);
        compounded *= Math.max(0, 1 + net / 100); // compounded view (account_multiple) stays floored at 0
        peakEq = Math.max(peakEq, equity);         // peakEq ≥ stake > 0 always → drawdown division is safe
        maxDD = Math.min(maxDD, ((equity - peakEq) / peakEq) * 100);
        curve.push(r2(equity));
        trades.push({ entry_date: new Date(times[open.idx]).toISOString().slice(0, 10), exit_date: new Date(times[i]).toISOString().slice(0, 10), bars: held, underlying_ret: r2(uret), ret: r2(net), gross_ret: r2(oret), multiple: r2(1 + net / 100, 3), reason });
        open = null;
      }
    }
    if (!open && ev.fired && i < end) {
      const sideOk = cand.dir === 'call' ? ev.side === 'buy' : ev.side === 'sell';
      if (sideOk) {
        // Vol known AT ENTRY only (no look-ahead). ATM strike = entry spot; price the contract.
        const sigma = realizedVol(closes.slice(0, i + 1));
        const prem0 = bsPrice(cand.dir, price, price, dte / 252, sigma);
        open = { idx: i, price, peak: 0, sigma, strike: price, prem0 };
      }
    }
  }
  const rets = trades.map((t) => t.ret);
  const decisive = trades.filter((t) => t.reason !== 'window-end');
  const wins = decisive.filter((t) => t.ret > 0).length;
  const grossWin = rets.filter((r) => r > 0).reduce((a, b) => a + b, 0);
  const grossLoss = Math.abs(rets.filter((r) => r < 0).reduce((a, b) => a + b, 0));
  const avg = rets.length ? rets.reduce((a, b) => a + b, 0) / rets.length : 0;
  void compounded;
  // Kelly inputs from the realized per-trade returns (decisive trades only — drop the
  // window-end mark-to-market so it can't pollute the win/loss split). avg_win/avg_loss are
  // MEAN MAGNITUDES; full Kelly f* = W − (1−W)/R with W=win prob, R=payoff ratio.
  const winRets = decisive.filter((t) => t.ret > 0).map((t) => t.ret);
  const lossRets = decisive.filter((t) => t.ret < 0).map((t) => Math.abs(t.ret));
  const avgWin = winRets.length ? winRets.reduce((a, b) => a + b, 0) / winRets.length : 0;
  const avgLoss = lossRets.length ? lossRets.reduce((a, b) => a + b, 0) / lossRets.length : 0;
  const R = avgLoss > 0 ? avgWin / avgLoss : 0;
  // Asymmetric Kelly = fraction of capital to deploy as premium per trade, maximizing log-growth
  // for a "win avg_win / lose avg_loss" bet: f* = expectancy / (avg_win × avg_loss) (all fractions),
  // clamped to [0,1]. Consistent with expectancy in the numerator (no edge ⇒ 0).
  const expFrac = avg / 100, wFrac = avgWin / 100, lFrac = avgLoss / 100;
  const kelly = (wFrac > 0 && lFrac > 0) ? Math.max(0, Math.min(1, expFrac / (wFrac * lFrac))) : (expFrac > 0 ? 1 : 0);
  const metrics: PlayMetrics = {
    num_trades: trades.length,
    win_rate: decisive.length ? r2((wins / decisive.length) * 100, 1) : 0,
    // Fixed-stake (NON-compounding) total return: each trade risks a fixed position, the
    // honest way to run options that can go to −100% (you never bet the whole account).
    total_return_pct: r2(((equity - stake) / stake) * 100, 1),
    avg_return_pct: r2(avg, 2),
    profit_factor: grossLoss > 0 ? r2(grossWin / grossLoss, 2) : (grossWin > 0 ? 99 : 0),
    best_multiple: trades.length ? r2(Math.max(...trades.map((t) => t.multiple)), 2) : 0,
    max_drawdown_pct: r2(maxDD, 1), // peak-to-trough of cumulative fixed-stake P/L (in % of one $1k stake)
    expectancy_pct: r2(avg, 2),
    avg_win_pct: r2(avgWin, 1), avg_loss_pct: r2(avgLoss, 1), payoff_ratio: r2(R, 2), kelly_fraction: r2(kelly, 3),
  };
  return { metrics, trades, equity_curve: curve };
}

/** Score a play for ranking: positive expectancy, confirmed over a real sample, rewarded
 *  for a healthy profit factor. Requires ≥8 trades so a lucky 2-3 can't win. Pure ranking
 *  heuristic (not a displayed metric). */
function scorePlay(m: PlayMetrics): number {
  if (m.num_trades < 8) return -1e9; // not enough evidence to trust
  return m.expectancy_pct * Math.sqrt(Math.min(m.num_trades, 50)) + (m.profit_factor - 1) * 25;
}

export type QuickbotBacktest = {
  symbol: string; days: number; from?: string; to?: string;
  all: PlayResult[];          // every signal×DTE combo, ranked
  chosen: PlayResult[];       // the selected plays (best bull(s) + best bear(s))
  series: { t: number; c: number }[];
  notes: string;
};

/** Run the full 1-year grid for one symbol and pick the winning plays. ONE bar fetch. */
export async function backtestQuickbot(symbol: string, opts: { days?: number } = {}): Promise<QuickbotBacktest> {
  symbol = symbol.toUpperCase();
  const days = opts.days ?? 365;
  const need = Math.ceil(days * 1.5) + 80; // calendar→trading + warmup
  const raw = await alpacaData.barsRaw(symbol, '1Day', Math.min(900, need)).catch(() => [] as any[]);
  const closes = raw.map((b: any) => Number(b.c));
  const times = raw.map((b: any) => Date.parse(b.t));
  if (closes.length < 120) throw new Error(`not enough bars for ${symbol} (${closes.length})`);
  const warmup = 55;
  const cutoffMs = Date.now() - days * 864e5;
  let windowStart = times.findIndex((t) => t >= cutoffMs);
  if (windowStart < warmup) windowStart = warmup;
  const end = closes.length - 1;
  // Precompute snapshots ONCE (shared across all plays).
  const snaps: any[] = new Array(closes.length);
  for (let i = warmup; i <= end; i++) snaps[i] = snapshot(closes.slice(0, i + 1));

  const midMs = (times[windowStart] + times[end]) / 2; // split point for out-of-sample check
  const all: PlayResult[] = [];
  for (const cand of CANDIDATES) {
    for (const dte of QUICK_DTES) {
      const band = DTE_BANDS[dte];
      const sim = simulatePlay(closes, times, snaps, windowStart, end, cand, dte, band);
      const h1 = sim.trades.filter((t) => Date.parse(t.exit_date) < midMs);
      const h2 = sim.trades.filter((t) => Date.parse(t.exit_date) >= midMs);
      const avg = (a: any[]) => (a.length ? a.reduce((s, t) => s + t.ret, 0) / a.length : 0);
      const oos = { h1: r2(avg(h1), 2), h2: r2(avg(h2), 2), h1n: h1.length, h2n: h2.length };
      const robust = oos.h1n >= 3 && oos.h2n >= 3 && oos.h1 > 0 && oos.h2 > 0;
      all.push({
        key: cand.key, label: cand.label, dir: cand.dir, dte, rules: cand.rules,
        risk: { tp: band.tp, sl: band.sl, trail: band.trail, max_position_usd: band.max_position_usd, qty: band.qty },
        metrics: sim.metrics, trades: sim.trades.slice(-40), equity_curve: sim.equity_curve, score: r2(scorePlay(sim.metrics), 1),
        robust, oos,
      });
    }
  }
  all.sort((a, b) => b.score - a.score);

  // Choose up to 2 calls + 2 puts (diversified by DTE). Prefer score>0 (positive
  // expectancy, real sample). To keep the bot BIDIRECTIONAL even in a one-way year, the
  // side with no score>0 play falls back to its single best by total return (only if
  // that's still positive) — so the bot can act on the other direction when a real
  // bearish/bullish signal fires, never forced to trade a net-losing setup.
  const pick = (dir: 'call' | 'put') => {
    const ranked = all.filter((p) => p.dir === dir);
    const out: PlayResult[] = [];
    // Pass 1: positive score AND out-of-sample robust (worked in BOTH halves) — diversify DTE.
    for (const p of ranked) {
      if (p.score <= 0 || !p.robust) continue;
      if (out.some((o) => o.dte === p.dte)) continue;
      out.push(p); if (out.length >= 2) break;
    }
    // Pass 2: if nothing robust, allow positive-score (in-sample) plays, diversified by DTE.
    if (!out.length) {
      for (const p of ranked) {
        if (p.score <= 0) continue;
        if (out.some((o) => o.dte === p.dte)) continue;
        out.push(p); if (out.length >= 2) break;
      }
    }
    // Pass 3 (bidirectional fallback): the best positive-total play so the bot can still
    // act on this direction when a real signal fires — never forced to trade a net loser.
    if (!out.length) {
      const best = ranked.filter((p) => p.metrics.num_trades >= 8 && p.metrics.total_return_pct > 0)
        .sort((a, b) => b.metrics.total_return_pct - a.metrics.total_return_pct)[0];
      if (best) out.push(best);
    }
    return out;
  };
  const chosen = [...pick('call'), ...pick('put')];

  const step = Math.max(1, Math.ceil((end - windowStart) / 260));
  const series: { t: number; c: number }[] = [];
  for (let i = windowStart; i <= end; i += step) series.push({ t: times[i], c: r2(closes[i]) });

  return {
    symbol, days,
    from: times[windowStart] ? new Date(times[windowStart]).toISOString().slice(0, 10) : undefined,
    to: times[end] ? new Date(times[end]).toISOString().slice(0, 10) : undefined,
    all, chosen, series,
    notes: `Modeled on REAL ${symbol} daily bars: each option is priced with Black–Scholes repriced along the path (true gamma upside + theta decay), nets a ${COST_PCT}% round-trip spread cost per trade, and exits on the premium’s TP/SL/trailing-stop (capped at DTE). Selection PREFERS plays positive OUT-OF-SAMPLE (both halves of the year) to guard against overfitting; a non-robust pick is used only as a clearly-labeled bidirectional fallback (shown "in-sample only"). Exact historical short-DTE fills aren’t sourceable, so this RANKS strategies rather than promising fills.`,
  };
}

export type WalkForwardFold = {
  fold: number; train_from: string; train_to: string; test_from: string; test_to: string;
  picked: { key: string; label: string; dir: 'call' | 'put'; dte: number } | null;
  is_expectancy: number; is_trades: number; oos_expectancy: number; oos_trades: number;
  oos_return_pct: number; oos_win_rate: number;
};
export type WalkForward = {
  symbol: string; days: number; folds: number;
  results: WalkForwardFold[];
  // Efficiency = mean out-of-sample expectancy ÷ mean in-sample expectancy. ~1.0 means the
  // edge held up live; <0.5 means the in-sample picks were largely curve-fit; ≤0 means the
  // "winning" plays actually LOST money out-of-sample (the classic overfit tell).
  efficiency: number; oos_positive_folds: number; oos_avg_expectancy: number; is_avg_expectancy: number;
  verdict: string; notes: string;
};

/** Walk-forward / anchored out-of-sample test. Splits the window into N sequential folds;
 *  for each fold it OPTIMIZES on the prior (in-sample) data — picks the best-scoring play —
 *  then measures THAT play on the next, unseen fold. Exposes plays whose backtest edge is
 *  curve-fit: high in-sample score, collapsing out-of-sample. Reuses the exact same BS
 *  simulator the leaderboard uses (no drift). */
export async function walkForwardQuickbot(symbol: string, opts: { days?: number; folds?: number } = {}): Promise<WalkForward> {
  symbol = symbol.toUpperCase();
  const days = opts.days ?? 365;
  const folds = Math.min(8, Math.max(3, opts.folds ?? 5));
  const need = Math.ceil(days * 1.5) + 80;
  const raw = await alpacaData.barsRaw(symbol, '1Day', Math.min(900, need)).catch(() => [] as any[]);
  const closes = raw.map((b: any) => Number(b.c));
  const times = raw.map((b: any) => Date.parse(b.t));
  if (closes.length < 160) throw new Error(`not enough bars for walk-forward on ${symbol} (${closes.length})`);
  const warmup = 55;
  const cutoffMs = Date.now() - days * 864e5;
  let windowStart = times.findIndex((t) => t >= cutoffMs);
  if (windowStart < warmup) windowStart = warmup;
  const end = closes.length - 1;
  const snaps: any[] = new Array(closes.length);
  for (let i = warmup; i <= end; i++) snaps[i] = snapshot(closes.slice(0, i + 1));

  // Split [windowStart, end] into `folds`+1 equal segments. Fold k optimizes on segments
  // [0..k] (anchored/expanding in-sample) and tests on segment k+1 (out-of-sample).
  const span = end - windowStart;
  const seg = Math.max(15, Math.floor(span / (folds + 1)));
  const dstr = (i: number) => (times[i] ? new Date(times[i]).toISOString().slice(0, 10) : '');
  const results: WalkForwardFold[] = [];
  for (let k = 0; k < folds; k++) {
    const trainStart = windowStart;
    const trainEnd = windowStart + seg * (k + 1);
    const testStart = trainEnd + 1;
    const testEnd = Math.min(end, trainEnd + seg);
    if (testStart >= testEnd) break;
    // Optimize on the in-sample window: highest score across all candidates × DTEs.
    let best: { cand: Cand; dte: number; m: PlayMetrics } | null = null;
    for (const cand of CANDIDATES) {
      for (const dte of QUICK_DTES) {
        const sim = simulatePlay(closes, times, snaps, trainStart, trainEnd, cand, dte, DTE_BANDS[dte]);
        if (scorePlay(sim.metrics) <= (best ? scorePlay(best.m) : -Infinity)) continue;
        best = { cand, dte, m: sim.metrics };
      }
    }
    if (!best) continue;
    // Measure THAT play out-of-sample on the unseen test window.
    const oos = simulatePlay(closes, times, snaps, testStart, testEnd, best.cand, best.dte, DTE_BANDS[best.dte]);
    results.push({
      fold: k + 1, train_from: dstr(trainStart), train_to: dstr(trainEnd), test_from: dstr(testStart), test_to: dstr(testEnd),
      picked: { key: best.cand.key, label: best.cand.label, dir: best.cand.dir, dte: best.dte },
      is_expectancy: r2(best.m.expectancy_pct, 2), is_trades: best.m.num_trades,
      oos_expectancy: r2(oos.metrics.expectancy_pct, 2), oos_trades: oos.metrics.num_trades,
      oos_return_pct: r2(oos.metrics.total_return_pct, 1), oos_win_rate: oos.metrics.win_rate,
    });
  }
  const isAvg = results.length ? results.reduce((s, r) => s + r.is_expectancy, 0) / results.length : 0;
  const oosAvg = results.length ? results.reduce((s, r) => s + r.oos_expectancy, 0) / results.length : 0;
  const oosPos = results.filter((r) => r.oos_expectancy > 0).length;
  const efficiency = isAvg > 0 ? r2(oosAvg / isAvg, 2) : (oosAvg > 0 ? 1 : 0);
  let verdict = 'inconclusive';
  if (results.length) {
    if (oosAvg > 0 && efficiency >= 0.6 && oosPos >= Math.ceil(results.length * 0.6)) verdict = 'robust — edge held out-of-sample';
    else if (oosAvg > 0 && efficiency >= 0.3) verdict = 'partial — degrades out-of-sample, size down';
    else verdict = 'overfit — in-sample edge did not survive (avoid / paper only)';
  }
  return {
    symbol, days, folds: results.length, results,
    efficiency, oos_positive_folds: oosPos, oos_avg_expectancy: r2(oosAvg, 2), is_avg_expectancy: r2(isAvg, 2),
    verdict,
    notes: `Anchored walk-forward: each fold re-optimizes the play on all data up to that point, then scores it on the NEXT unseen segment. Same Black–Scholes simulator as the leaderboard. Efficiency = out-of-sample ÷ in-sample expectancy — the honest overfit detector (a leaderboard "winner" with efficiency ≤ 0 made its money purely in-sample).`,
  };
}

// ── Arbitrary-rule option simulation (used by the learning iterator) ───────────
// A generated strategy idea is just a rule object the engine already understands, so it
// is measured by the SAME Black–Scholes simulator, exit ladder and spread cost as the
// leaderboard — no second, friendlier backtester for machine-written ideas.

type IdeaSeries = { at: number; closes: number[]; times: number[]; snaps: any[]; warmup: number };
const _ideaSeries = new Map<string, IdeaSeries>();

/** Bars + precomputed snapshots for one symbol, cached 15 min (a learning run backtests
 *  several ideas over the same handful of symbols; snapshots are the expensive part). */
async function ideaSeries(symbol: string, days: number): Promise<IdeaSeries> {
  const key = `${symbol}:${days}`;
  const hit = _ideaSeries.get(key);
  if (hit && Date.now() - hit.at < 900_000) return hit;
  const need = Math.ceil(days * 1.5) + 80;
  const raw = await alpacaData.barsRaw(symbol, '1Day', Math.min(900, need)).catch(() => [] as any[]);
  const closes = raw.map((b: any) => Number(b.c));
  const times = raw.map((b: any) => Date.parse(b.t));
  if (closes.length < 120) throw new Error(`not enough bars for ${symbol} (${closes.length})`);
  const warmup = 55;
  const snaps: any[] = new Array(closes.length);
  for (let i = warmup; i < closes.length; i++) snaps[i] = snapshot(closes.slice(0, i + 1));
  const entry: IdeaSeries = { at: Date.now(), closes, times, snaps, warmup };
  _ideaSeries.set(key, entry);
  return entry;
}

export type IdeaBacktest = {
  symbol: string; dir: 'call' | 'put'; dte: number; days: number; from?: string; to?: string;
  metrics: PlayMetrics; trades: any[]; oos: { h1: number; h2: number; h1n: number; h2n: number }; robust: boolean;
};

/** Backtest ONE arbitrary rule object as a short-DTE option play on one symbol. */
export async function backtestIdeaPlay(
  symbol: string,
  spec: { rules: any; dir: 'call' | 'put'; dte: number; band?: { tp: number; sl: number; trail: number } },
  opts: { days?: number } = {},
): Promise<IdeaBacktest> {
  symbol = symbol.toUpperCase();
  const days = opts.days ?? 365;
  const dte = QUICK_DTES.includes(spec.dte) ? spec.dte : 7;
  const s = await ideaSeries(symbol, days);
  const end = s.closes.length - 1;
  const cutoffMs = Date.now() - days * 864e5;
  let windowStart = s.times.findIndex((t) => t >= cutoffMs);
  if (windowStart < s.warmup) windowStart = s.warmup;
  const defaults = DTE_BANDS[dte];
  const band = { tp: spec.band?.tp ?? defaults.tp, sl: spec.band?.sl ?? defaults.sl, trail: spec.band?.trail ?? defaults.trail };
  const cand: Cand = { key: 'idea', label: 'idea', dir: spec.dir, rules: spec.rules, explain: '' };
  const sim = simulatePlay(s.closes, s.times, s.snaps, windowStart, end, cand, dte, band);
  const midMs = (s.times[windowStart] + s.times[end]) / 2;
  const h1 = sim.trades.filter((t) => Date.parse(t.exit_date) < midMs);
  const h2 = sim.trades.filter((t) => Date.parse(t.exit_date) >= midMs);
  const avg = (a: any[]) => (a.length ? a.reduce((x, t) => x + t.ret, 0) / a.length : 0);
  const oos = { h1: r2(avg(h1), 2), h2: r2(avg(h2), 2), h1n: h1.length, h2n: h2.length };
  return {
    symbol, dir: spec.dir, dte, days,
    from: s.times[windowStart] ? new Date(s.times[windowStart]).toISOString().slice(0, 10) : undefined,
    to: s.times[end] ? new Date(s.times[end]).toISOString().slice(0, 10) : undefined,
    metrics: sim.metrics, trades: sim.trades, // FULL list: the caller aggregates across symbols
    oos, robust: oos.h1n >= 3 && oos.h2n >= 3 && oos.h1 > 0 && oos.h2 > 0,
  };
}

/** The signal catalog (for the "+ add play" UI): each entry carries a plain-English
 *  explanation + which numeric thresholds are tweakable (with ranges/hints). */
export const SIGNAL_CATALOG = CANDIDATES.map((c) => ({
  key: c.key, label: c.label, dir: c.dir, rules: c.rules, explain: c.explain,
  // Tweakable params = the numeric rule keys present that have metadata.
  params: Object.keys(c.rules).filter((k) => PARAM_META[k]).map((k) => ({ key: k, value: c.rules[k], ...PARAM_META[k] })),
}));

// ── Live evaluation ────────────────────────────────────────────────────────────

export type QuickPlay = { name: string; key: string; direction: 'call' | 'put'; dte: number; strike_target: string; rules: any;
  risk: { tp: number; sl: number; trail: number; max_position_usd: number; qty: number };
  // Backtest provenance (shown in the UI so the user sees each play's edge at a glance).
  robust?: boolean; backtest?: { total_return_pct: number; win_rate: number; profit_factor: number; num_trades: number } };
export type QuickbotConfig = {
  plays: QuickPlay[];                            // default plays (single-symbol bots use this)
  symbol_plays?: Record<string, QuickPlay[]>;    // per-symbol overrides (auto-tuned basket)
};

/** The plays a bot trades on a given symbol: its per-symbol set if auto-tuned, else default. */
export function playsForSymbol(cfg: QuickbotConfig, symbol: string): QuickPlay[] {
  const sp = cfg.symbol_plays?.[symbol.toUpperCase()];
  return (sp && sp.length) ? sp : (cfg.plays || []);
}

/** Evaluate a QuickBot live: for each symbol, run its plays; the first matching play per
 *  direction fires an option at its DTE with its DTE-scaled risk. Returns per-symbol
 *  reasoning (same shape as the generic engine so the dashboard "why" panel works). */
export async function evaluateQuickbot(botRow: any): Promise<any[]> {
  const cfg: QuickbotConfig = parse(botRow.action)?._quickbot ? parse(botRow.action) : { plays: [] };
  const symbols: string[] = parse(botRow.symbols) || [];
  const env = await getTradingEnv();
  const results: any[] = [];
  const closesCache = new Map<string, number[]>();
  const { refreshBars } = await import('./brokers/index.js'); // hoisted out of the per-symbol loop

  for (const symRaw of symbols) {
    const symbol = String(symRaw).toUpperCase();
    const plays = playsForSymbol(cfg, symbol); // per-symbol auto-tuned plays
    if (!plays.length) { results.push({ symbol, fired: false, why: 'No plays configured for this symbol (no robust edge found at last tuning).' }); continue; }
    try {
      let closes = closesCache.get(symbol);
      if (!closes) { closes = await refreshBars(symbol, '1Day', 120); closesCache.set(symbol, closes); }
      const snap = snapshot(closes);
      const fired: any[] = [];
      const considered: any[] = [];
      for (const play of plays) {
        const ev = evalRules(play.rules, snap);
        const sideOk = play.direction === 'call' ? ev.side === 'buy' : ev.side === 'sell';
        considered.push({ play: play.name, dir: play.direction, dte: play.dte, fired: ev.fired && sideOk, why: ev.why });
        if (ev.fired && sideOk) fired.push(play);
      }
      if (!fired.length) {
        results.push({ symbol, fired: false, why: `No play triggered. ${considered.map((c) => `${c.play}: ${c.why}`).join(' | ')}`, plays: considered, last: snap.last ?? null });
        continue;
      }
      // Fire each matching play. A play's signal (e.g. "up >0.8% today") often HOLDS for
      // the whole session while the worker re-evaluates every 120s — so dedup is critical
      // or we'd re-buy every 2 minutes. The dedup key is the CONTRACT IDENTITY (direction +
      // DTE → same expiry/strike), stable ASCII, matched both in-cycle and across the day.
      const fireSummaries: any[] = [];
      const seen = new Set<string>();
      for (const play of fired) {
        const tag = `${play.direction}-${play.dte}`;
        if (seen.has(tag)) continue; seen.add(tag);
        // RE-ENTRY POLICY (shared with the generic engine): a few entries/day per symbol+side,
        // SPACED by a cooldown — so a play whose signal holds all session becomes 3–5 distinct
        // adds, not a re-buy every 120s. The transient in-flight lock just closes the
        // SELECT→INSERT race (manual "Run now" vs the worker tick); it's released right after.
        const lockKey = `${botRow.id}:${symbol}:buy`;
        if (!claimEntrySlot(lockKey)) { fireSummaries.push({ play: play.name, skipped: 'entry in-flight' }); continue; }
        try {
          const skip = await reentryGate({ botId: botRow.id, symbol, side: 'buy', env, riskCfg: botRow.risk });
          if (skip) { fireSummaries.push({ play: play.name, skipped: skip }); continue; }
          const band = play.risk;
          const draft: OrderDraft = {
            env: (botRow.env || env) as any,
            symbol, asset_class: 'option', side: 'buy', qty: Number(band.qty || 1), order_type: 'market',
            option_type: play.direction, strike_target: (play.strike_target as any) || 'atm',
            expiration: dteToExpiration(play.dte), est_price: undefined, source: 'bot', bot_id: botRow.id,
            _play: { name: play.name, tag, dte: play.dte, tp: band.tp, sl: band.sl, trail: band.trail, maxPositionUsd: band.max_position_usd },
          };
          // SIZING: the play's band qty is a floor of 1 contract, not a deliberate pin — so the
          // effective amount per trade (bot override, else the global trade default) decides how
          // many contracts, capped by the band's own max_position_usd inside sizeDraft.
          const sized = await sizeDraft(draft, { risk: botRow.risk, env: (botRow.env || env) as TradingEnv, pinnedQty: null });
          if (!sized.ok) { fireSummaries.push({ play: play.name, skipped: `not sized: ${sized.reason}` }); continue; }
          const ex = await executeDraft(draft, { modeOverride: botRow.mode, rationale: `quickbot:${botRow.name} ${play.name} (${play.direction} ${play.dte}DTE)` });
          fireSummaries.push({ play: play.name, direction: play.direction, dte: play.dte, action: ex.action, status: ex.status, reason: ex.reason });
        } finally {
          releaseEntrySlot(lockKey); // count + cooldown (reentryGate) govern frequency, not the lock
        }
      }
      results.push({ symbol, fired: true, why: `Fired ${fireSummaries.length} play(s): ${fireSummaries.map((f) => f.play + (f.skipped ? ` (${f.skipped})` : ` → ${f.status || f.action}`)).join(', ')}`, fires: fireSummaries, plays: considered });
    } catch (e: any) {
      results.push({ symbol, error: e?.message || String(e) });
    }
  }
  await exec('UPDATE bots SET last_evaluated_at=NOW(), last_result=CAST(:r AS JSON) WHERE id=:id AND env=:env', { r: JSON.stringify(results), id: botRow.id, env: botRow.env });
  await audit('quickbot.eval', `evaluated ${botRow.name}`, { id: botRow.id, results });
  return results;
}

// ── Seeding (build the two go-to QuickBots from fresh backtests) ─────────────────

function parse(v: any): any { if (v == null) return null; if (typeof v === 'object') return v; try { return JSON.parse(v); } catch { return null; } }

/** Turn a symbol's backtest winners into live play configs (carrying their edge stats). */
function playsFromChosen(chosen: PlayResult[]): QuickPlay[] {
  return chosen.map((p) => ({
    name: `${p.dir === 'call' ? 'CALL' : 'PUT'} ${p.label} · ${p.dte}DTE`,
    key: p.key, direction: p.dir, dte: p.dte, strike_target: 'atm', rules: p.rules, risk: p.risk,
    robust: p.robust,
    backtest: { total_return_pct: p.metrics.total_return_pct, win_rate: p.metrics.win_rate, profit_factor: p.metrics.profit_factor, num_trades: p.metrics.num_trades },
  }));
}

// Keys used for an UNTUNED fleet: the classic, well-understood baselines (2 calls, 1 put)
// that every account starts with until its own backtests have run.
const DEFAULT_PLAY_KEYS = ['momo_up', 'breakout_up', 'breakdown_dn'];
const DEFAULT_PLAY_DTE = 7;

/** Catalog-default plays: the baseline signals at the default DTE with that DTE's risk band
 *  and NO backtest provenance (nothing has been measured for this account yet). Used when a
 *  new account needs a fleet immediately — seeding must not wait minutes for backtests, and
 *  must work with the market closed. The bot is flagged `_needs_tuning` so the existing
 *  re-tune (POST /api/quickbots/seed {force:true}) replaces these with measured plays. */
function catalogDefaultPlays(): QuickPlay[] {
  const band = DTE_BANDS[DEFAULT_PLAY_DTE];
  return DEFAULT_PLAY_KEYS
    .map((k) => CANDIDATES.find((c) => c.key === k))
    .filter((c): c is Cand => !!c)
    .map((c) => ({
      name: `${c.dir === 'call' ? 'CALL' : 'PUT'} ${c.label} · ${DEFAULT_PLAY_DTE}DTE`,
      key: c.key, direction: c.dir, dte: DEFAULT_PLAY_DTE, strike_target: 'atm',
      rules: JSON.parse(JSON.stringify(c.rules)),
      risk: { tp: band.tp, sl: band.sl, trail: band.trail, max_position_usd: band.max_position_usd, qty: band.qty },
    }));
}

/** Backtest EVERY symbol in the universe across the whole strategy catalog and rank the
 *  results into a global leaderboard ("which symbol × strategy × DTE would have paid"). The
 *  honest 2-10x view: total return on a fixed $1k-per-trade stake + best single-trade
 *  multiple + profit factor, with robust (out-of-sample) plays surfaced first. */
export async function scanUniverse(opts: { days?: number; symbols?: string[] } = {}): Promise<any> {
  const days = opts.days ?? 365;
  const symbols = opts.symbols ?? UNIVERSE;
  const perSymbol: any[] = [];
  const board: any[] = [];
  for (const sym of symbols) {
    try {
      const bt = await backtestQuickbot(sym, { days });
      perSymbol.push({ symbol: sym, from: bt.from, to: bt.to, chosen: bt.chosen });
      for (const p of bt.all) {
        if (p.metrics.num_trades < 8) continue; // need a real sample to rank
        board.push({ symbol: sym, key: p.key, label: p.label, dir: p.dir, dte: p.dte, robust: p.robust, metrics: p.metrics, rules: p.rules, risk: p.risk });
      }
    } catch (e: any) { perSymbol.push({ symbol: sym, error: e?.message || String(e) }); }
  }
  // Robust first, then by fixed-stake total return, then profit factor.
  board.sort((a, b) => (Number(b.robust) - Number(a.robust)) || (b.metrics.total_return_pct - a.metrics.total_return_pct) || (b.metrics.profit_factor - a.metrics.profit_factor));
  return {
    days, symbols, as_of: new Date().toISOString().slice(0, 10),
    counts: { tested: board.length, robust: board.filter((r) => r.robust).length, positive: board.filter((r) => r.metrics.total_return_pct > 0).length },
    leaderboard: board.slice(0, 80),
    perSymbol,
  };
}

// Cache the (expensive) universe scan ~10 min + SINGLE-FLIGHT per `days` so concurrent
// dashboard loads don't each kick off a full 600-sim scan.
let _board: { at: number; days: number; data: any } | null = null;
const _boardInflight = new Map<number, Promise<any>>();
export async function quickbotLeaderboard(days = 365): Promise<any> {
  if (_board && _board.days === days && Date.now() - _board.at < 600_000) return _board.data;
  const inflight = _boardInflight.get(days);
  if (inflight) return inflight;
  const p = (async () => { const data = await scanUniverse({ days }); _board = { at: Date.now(), days, data }; return data; })()
    .finally(() => _boardInflight.delete(days));
  _boardInflight.set(days, p);
  return p;
}

// The managed bot that accumulates one-click "Run" picks from the leaderboard.
export const PICKS_BOT = 'Leaderboard Picks';

/** One-click run a backtested leaderboard play: resolve its rules from the SERVER catalog
 *  (never trust client rules) + its DTE risk band, add it to the managed "Leaderboard
 *  Picks" QuickBot (per-symbol, deduped), enable it, and set the requested mode. Fills
 *  auto-create monitors (TP/SL/trail + the no-overnight flatten), so "run + monitor" is one click. */
export async function runLeaderboardPlay(env: TradingEnv, opts: { symbol: string; key: string; dte: number; mode?: string; robust?: boolean; backtest?: any }): Promise<any> {
  const symbol = String(opts.symbol || '').toUpperCase();
  const cand = CANDIDATES.find((c) => c.key === opts.key);
  if (!symbol || !/^[A-Z.]{1,6}$/.test(symbol)) throw new Error('invalid symbol');
  if (!cand) throw new Error(`unknown strategy '${opts.key}'`);
  const dte = QUICK_DTES.includes(Number(opts.dte)) ? Number(opts.dte) : 7;
  const band = DTE_BANDS[dte] || DTE_BANDS[7];
  const mode = ['observe', 'cautious', 'auto', 'full_auto'].includes(opts.mode || '') ? opts.mode! : 'cautious';
  // Route picks to a MODE-SPECIFIC managed bot so a full-auto pick can't flip your staged
  // picks (and vice-versa). Each mode gets its own "Leaderboard Picks" bot.
  const modeLabel = mode === 'full_auto' ? 'Full-Auto' : mode === 'auto' ? 'Auto' : mode === 'observe' ? 'Observe' : 'Staged';
  const botName = `${PICKS_BOT} · ${modeLabel}`;
  const play: QuickPlay = {
    name: `${cand.dir === 'call' ? 'CALL' : 'PUT'} ${cand.label} · ${dte}DTE`,
    key: cand.key, direction: cand.dir, dte, strike_target: 'atm',
    rules: JSON.parse(JSON.stringify(cand.rules)),
    risk: { tp: band.tp, sl: band.sl, trail: band.trail, max_position_usd: band.max_position_usd, qty: band.qty },
    robust: opts.robust, backtest: opts.backtest,
  };

  const [bot] = await q<any>('SELECT * FROM bots WHERE env=:env AND name=:n LIMIT 1', { env, n: botName });
  const action: any = bot ? (typeof bot.action === 'string' ? JSON.parse(bot.action) : bot.action) : { _quickbot: true, _category: 'quickbot', _picks: true, _research: symbol, plays: [], symbol_plays: {} };
  action._picks = true; action._quickbot = true;
  if (!action.symbol_plays) action.symbol_plays = {};
  let symbols: string[] = bot ? (typeof bot.symbols === 'string' ? JSON.parse(bot.symbols) : bot.symbols) : [];
  const list: QuickPlay[] = action.symbol_plays[symbol] || [];
  const exists = list.some((p) => p.direction === play.direction && p.dte === play.dte && p.key === play.key);
  if (!exists) list.push(play);
  action.symbol_plays[symbol] = list;
  if (!symbols.includes(symbol)) symbols = [...symbols, symbol];
  const allPlays = Object.values(action.symbol_plays).flat() as QuickPlay[];
  const risk = { override: true, max_position_usd: Math.max(...allPlays.map((p) => p.risk.max_position_usd), 2000), max_concentration_pct: 35, max_daily_loss_pct: 25, max_orders_per_day: 20, dte_bands: DTE_BANDS };

  if (bot) {
    // Keep the bot's existing mode (it already matches — it's the mode-specific bot). Enable it.
    await exec('UPDATE bots SET enabled=1, mode=:m, symbols=CAST(:s AS JSON), action=CAST(:a AS JSON), risk=CAST(:r AS JSON) WHERE id=:id AND env=:env',
      { m: mode, s: JSON.stringify(symbols), a: JSON.stringify(action), r: JSON.stringify(risk), id: bot.id, env });
    return { bot_id: bot.id, name: botName, symbol, play: play.name, mode, added: !exists, already: exists, plays: allPlays.length };
  }
  const ins = await exec(
    `INSERT INTO bots (name, env, enabled, symbols, asset_class, rules, ai_gate, action, risk, mode)
     VALUES (:name,:env,1,CAST(:s AS JSON),'option',CAST('{}' AS JSON),CAST('{"enabled":false}' AS JSON),CAST(:a AS JSON),CAST(:r AS JSON),:m)`,
    { name: botName, env, s: JSON.stringify(symbols), a: JSON.stringify(action), r: JSON.stringify(risk), m: mode });
  return { bot_id: ins.insertId, name: botName, symbol, play: play.name, mode, added: true, created: true, plays: allPlays.length };
}

/** Seed (or re-tune) the QuickBot fleet for ONE account (env).
 *  `tuned:false` seeds catalog defaults instantly (no backtests, no market data, works when
 *  the market is closed) and flags the bots `_needs_tuning`; the default `tuned:true` path is
 *  the existing empirical one (a year of backtests per symbol). */
export async function seedQuickbots(env: TradingEnv, opts: { force?: boolean; tuned?: boolean } = {}): Promise<any> {
  const tuned0 = opts.tuned !== false;
  // perSymbol=true → each ticker is backtested on its OWN data and gets its own plays.
  const specs = [
    { name: 'Mag-7 Momentum Fleet', symbols: MAG7, perSymbol: true },
    { name: 'Index QuickBot — SPY & QQQ', symbols: ['SPY', 'QQQ'], perSymbol: true },
  ];
  // On a forced re-tune, clear out old quickbots first so renamed/retired ones don't linger.
  if (opts.force) {
    // Never wipe the user's Leaderboard Picks bots (any mode-specific "· Staged/Full-Auto/…").
    const old = await q<{ id: number; name: string; picks: any }>("SELECT id, name, JSON_EXTRACT(action,'$._picks') picks FROM bots WHERE env=:env AND JSON_EXTRACT(action,'$._quickbot')=true", { env });
    const keep = new Set(specs.map((s) => s.name));
    for (const b of old) if (!keep.has(b.name) && !b.picks && !String(b.name).startsWith(PICKS_BOT)) await exec('DELETE FROM bots WHERE id=:id AND env=:env', { id: b.id, env });
  }
  const out: any[] = [];
  for (const spec of specs) {
    const existing = await q<{ id: number }>('SELECT id FROM bots WHERE env=:env AND name=:n LIMIT 1', { env, n: spec.name });
    if (existing.length && !opts.force) { out.push({ name: spec.name, id: existing[0].id, skipped: 'exists' }); continue; }

    // Build the config. Single-symbol → just `plays`. Basket → per-symbol `symbol_plays`,
    // each AUTO-TUNED on that ticker's own year of data.
    let plays: QuickPlay[] = [];
    const symbolPlays: Record<string, QuickPlay[]> = {};
    const tuned: Record<string, number> = {};
    if (!tuned0) {
      // Untuned fleet: catalog defaults, identical for every symbol (nothing measured yet).
      plays = catalogDefaultPlays();
    } else if (spec.perSymbol) {
      for (const sym of spec.symbols) {
        try {
          const bt = await backtestQuickbot(sym, { days: 365 });
          const sp = playsFromChosen(bt.chosen);
          if (sp.length) { symbolPlays[sym] = sp; tuned[sym] = sp.length; }
        } catch (e: any) { tuned[sym] = 0; void e; }
      }
      // Fallback `plays` (for any symbol that failed) = the most common winning set (QQQ-like).
      const qqq = await backtestQuickbot('QQQ', { days: 365 }).catch(() => null);
      plays = qqq ? playsFromChosen(qqq.chosen) : (Object.values(symbolPlays)[0] || []);
    } else {
      const bt = await backtestQuickbot(spec.symbols[0], { days: 365 });
      plays = playsFromChosen(bt.chosen);
    }
    if (!plays.length && !Object.keys(symbolPlays).length) { out.push({ name: spec.name, error: 'no profitable plays found' }); continue; }

    const action: any = { _quickbot: true, _category: 'quickbot', _research: spec.symbols[0], plays };
    if (spec.perSymbol && tuned0) action.symbol_plays = symbolPlays;
    // Honest provenance: these plays are catalog defaults, not this account's measured edge.
    if (!tuned0) { action._needs_tuning = true; action._untuned_reason = 'catalog defaults, not measured on this account yet. Re-tune to fit its own data.'; }
    const allPlays = [...plays, ...Object.values(symbolPlays).flat()];
    const risk = {
      override: true, // OVERRIDES global limits for this bot (per the user's request)
      max_position_usd: Math.max(...allPlays.map((p) => p.risk.max_position_usd), 850),
      max_concentration_pct: 35, max_daily_loss_pct: 25, max_orders_per_day: 20, dte_bands: DTE_BANDS,
    };

    if (existing.length) {
      await exec('UPDATE bots SET symbols=CAST(:s AS JSON), asset_class=\'option\', rules=CAST(\'{}\' AS JSON), action=CAST(:a AS JSON), risk=CAST(:r AS JSON) WHERE id=:id AND env=:env',
        { s: JSON.stringify(spec.symbols), a: JSON.stringify(action), r: JSON.stringify(risk), id: existing[0].id, env });
      out.push({ name: spec.name, id: existing[0].id, updated: true, plays: plays.length, per_symbol: spec.perSymbol ? tuned : undefined });
    } else {
      const ins = await exec(
        `INSERT INTO bots (name, env, enabled, symbols, asset_class, rules, ai_gate, action, risk, mode)
         VALUES (:name,:env,0,CAST(:s AS JSON),'option',CAST('{}' AS JSON),CAST('{"enabled":false}' AS JSON),CAST(:a AS JSON),CAST(:r AS JSON),'cautious')`,
        { name: spec.name, env, s: JSON.stringify(spec.symbols), a: JSON.stringify(action), r: JSON.stringify(risk) });
      out.push({ name: spec.name, id: ins.insertId, created: true, plays: plays.length, tuned: tuned0, per_symbol: spec.perSymbol && tuned0 ? tuned : undefined });
    }
  }
  return { seeded: out };
}
