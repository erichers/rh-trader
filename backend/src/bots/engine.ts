import { q, exec, audit, getTradingEnv } from '../db.js';
import type { Mode, TradingEnv } from '../config.js';
import { snapshot } from '../market/indicators.js';
import { dteToExpiration } from '../market/expirations.js';
import { analyzeSymbol, aiReady } from '../ai/claude.js';
import { executeDraft } from '../execute.js';
import type { OrderDraft } from '../risk/engine.js';
import { isCryptoSymbol } from '../config.js';
import { refreshBars } from '../brokers/index.js';
import { sizeDraft } from '../risk/sizing.js';

export type Bot = {
  id: number;
  name: string;
  env: TradingEnv;          // the account this bot belongs to
  enabled: number;
  symbols: string[];
  asset_class: string;
  rules: any;
  ai_gate: any;
  action: any;
  risk: any;
  mode: Mode;
};

function safeParseJSON(s: string): any { try { return JSON.parse(s); } catch { return null; } }

function parseBot(row: any): Bot {
  const j = (v: any, d: any) => {
    if (v == null) return d;
    if (typeof v === 'object') return v;
    try {
      return JSON.parse(v);
    } catch {
      return d;
    }
  };
  return {
    id: row.id,
    name: row.name,
    env: (row.env || 'alpaca_paper') as TradingEnv,
    enabled: row.enabled,
    symbols: j(row.symbols, []),
    asset_class: row.asset_class || 'equity',
    rules: j(row.rules, {}),
    ai_gate: j(row.ai_gate, { enabled: false }),
    action: j(row.action, { side: 'buy', qty: 1, order_type: 'market' }),
    risk: j(row.risk, {}),
    mode: row.mode || 'observe',
  };
}

// ── Re-entry policy ─────────────────────────────────────────────────────────
// Bots evaluate DAILY-bar signals every 120s, and a daily signal (e.g. EMA9>EMA21) stays
// TRUE for the whole session. So instead of one-entry-per-day (too few) or no guard at all
// (re-buys every 2 min), allow a FEW entries per day SPACED by a cooldown: that turns a
// persistently-true signal into 3–5 distinct, spread-out adds and lets a signal that flips
// off→on re-fire. Per-bot override via risk.{max_entries_per_day, reentry_cooldown_min};
// defaults give up to 4 entries, ≥45 min apart.
export const DEFAULT_MAX_ENTRIES_PER_DAY = 4;
export const DEFAULT_REENTRY_COOLDOWN_MIN = 45;

export function reentryLimits(riskCfg: any): { maxEntries: number; cooldownMin: number } {
  const r = typeof riskCfg === 'string' ? safeParseJSON(riskCfg) : (riskCfg || {});
  const clampI = (v: any, lo: number, hi: number, d: number) => {
    const n = Math.floor(Number(v));
    return Number.isFinite(n) && n > 0 ? Math.min(hi, Math.max(lo, n)) : d;
  };
  return {
    maxEntries: clampI(r?.max_entries_per_day, 1, 10, DEFAULT_MAX_ENTRIES_PER_DAY),
    cooldownMin: clampI(r?.reentry_cooldown_min, 1, 390, DEFAULT_REENTRY_COOLDOWN_MIN),
  };
}

/** Gate a potential entry against the per-day count + cooldown (scoped to bot+symbol+side in the
 *  active env, counting only REAL entries — vetoed/rejected/canceled don't count). Returns null
 *  if it's OK to enter, else a human-readable skip reason. Robust to broker-sync overwriting an
 *  order's `raw` (counts off table columns, not JSON). */
export async function reentryGate(opts: { botId: number; symbol: string; side: string; env: string; riskCfg: any }): Promise<string | null> {
  const { maxEntries, cooldownMin } = reentryLimits(opts.riskCfg);
  const [agg] = await q<{ n: number; last_at: any }>(
    `SELECT COUNT(*) n, MAX(created_at) last_at FROM orders
       WHERE bot_id=:bid AND symbol=:s AND side=:side AND env=:env
         AND status NOT IN ('vetoed','rejected','canceled') AND created_at >= CURDATE()`,
    { bid: opts.botId, s: opts.symbol, side: opts.side, env: opts.env },
  );
  const n = Number(agg?.n ?? 0);
  if (n >= maxEntries) return `Max entries today reached (${n}/${maxEntries}) — skipped until tomorrow.`;
  if (agg?.last_at) {
    const mins = (Date.now() - new Date(agg.last_at).getTime()) / 60000;
    if (mins >= 0 && mins < cooldownMin) return `Re-entry cooldown: ${Math.round(mins)}/${cooldownMin} min since last entry (${n}/${maxEntries} today).`;
  }
  return null;
}

// In-process "entry in-flight" lock: a transient claim around the gate→place window that closes
// the SELECT→INSERT race when a manual "Run now" coincides with the worker tick (single process).
// Released immediately after placement — the day-count + cooldown above govern actual frequency.
const _entryInFlight = new Set<string>();
export function claimEntrySlot(key: string): boolean { if (_entryInFlight.has(key)) return false; _entryInFlight.add(key); return true; }
export function releaseEntrySlot(key: string): void { _entryInFlight.delete(key); }

async function closesFor(symbol: string, timeframe = '1Day', limit = 120): Promise<number[]> {
  // Pull real bars from Alpaca (and cache to market_bars). Falls back to cache.
  const fresh = await refreshBars(symbol, timeframe, limit);
  if (fresh.length) return fresh;
  const rows = await q<{ c: number }>(
    'SELECT c FROM market_bars WHERE symbol=:s AND timeframe=:tf ORDER BY ts ASC LIMIT :lim',
    { s: symbol, tf: timeframe, lim: limit },
  );
  return rows.map((r) => Number(r.c)).filter((n) => Number.isFinite(n));
}

/** One condition's evaluation — shown to the user so they can see exactly why a bot
 *  did or didn't fire. `kind` separates entry TRIGGERS from gating FILTERS. */
export type RuleCheck = { label: string; ok: boolean; detail: string; kind: 'filter' | 'trigger' };

/** Evaluate a rule object against an indicator snapshot. Returns the fire decision PLUS
 *  a per-condition breakdown (`checks`) and a plain-English `why` so the UI can explain
 *  precisely which conditions held and which blocked the trade. */
export function evalRules(
  rules: any,
  snap: ReturnType<typeof snapshot>,
): { fired: boolean; matched: string[]; side: 'buy' | 'sell'; checks: RuleCheck[]; why: string } {
  const r = rules || {};
  const checks: RuleCheck[] = [];
  let side: 'buy' | 'sell' = 'buy';
  const n = (x: number | null | undefined) => (x == null ? '—' : (Math.round(x * 100) / 100).toString());

  // RSI oversold / overbought (triggers).
  if (r.rsi_below != null) {
    const v = snap.rsi14; const ok = v != null && v < r.rsi_below;
    checks.push({ kind: 'trigger', ok, label: `RSI < ${r.rsi_below}`, detail: v == null ? 'no RSI data' : `RSI ${n(v)} ${ok ? '<' : '≥'} ${r.rsi_below}` });
    if (ok) side = 'buy';
  }
  if (r.rsi_above != null) {
    const v = snap.rsi14; const ok = v != null && v > r.rsi_above;
    checks.push({ kind: 'trigger', ok, label: `RSI > ${r.rsi_above}`, detail: v == null ? 'no RSI data' : `RSI ${n(v)} ${ok ? '>' : '≤'} ${r.rsi_above}` });
    if (ok) side = 'sell';
  }
  // EMA9×EMA21 crossover EVENT (fires on the cross, not every bar it stays above).
  if (r.ema_cross) {
    const have = snap.ema9 != null && snap.ema21 != null && snap.prev.ema9 != null && snap.prev.ema21 != null;
    const ok = have && snap.prev.ema9! <= snap.prev.ema21! && snap.ema9! > snap.ema21!;
    const detail = !have ? 'insufficient data'
      : ok ? 'EMA9 crossed above EMA21 today'
      : snap.ema9! > snap.ema21! ? `EMA9 ${n(snap.ema9)} already > EMA21 ${n(snap.ema21)} (no fresh cross)`
      : `EMA9 ${n(snap.ema9)} ≤ EMA21 ${n(snap.ema21)} (downtrend, no cross)`;
    checks.push({ kind: 'trigger', ok, label: 'EMA9 crosses above EMA21', detail });
    if (ok) side = 'buy';
  }
  // Price-above-SMA20 trend FILTER (must hold; not an entry trigger by itself).
  if (r.price_above_sma20) {
    const have = snap.last != null && snap.sma20 != null;
    const ok = have && snap.last! > snap.sma20!;
    checks.push({ kind: 'filter', ok, label: 'price > SMA20 (trend filter)', detail: !have ? 'insufficient data' : `price ${n(snap.last)} ${ok ? '>' : '≤'} SMA20 ${n(snap.sma20)}` });
  }
  // Price-below-SMA20 trend FILTER (for bearish/put continuation — only short with the downtrend).
  if (r.price_below_sma20) {
    const have = snap.last != null && snap.sma20 != null;
    const ok = have && snap.last! < snap.sma20!;
    checks.push({ kind: 'filter', ok, label: 'price < SMA20 (downtrend filter)', detail: !have ? 'insufficient data' : `price ${n(snap.last)} ${ok ? '<' : '≥'} SMA20 ${n(snap.sma20)}` });
  }
  // MACD histogram crossing ABOVE zero (event, not persistent positive state).
  if (r.macd_positive) {
    const have = !!snap.macd && snap.prev.macdHist != null;
    const ok = have && snap.prev.macdHist! <= 0 && snap.macd!.hist > 0;
    const detail = !have ? 'insufficient data'
      : ok ? 'MACD histogram crossed above 0 today'
      : snap.macd!.hist > 0 ? `MACD hist ${n(snap.macd!.hist)} already positive (no fresh cross)`
      : `MACD hist ${n(snap.macd!.hist)} ≤ 0 (not positive)`;
    checks.push({ kind: 'trigger', ok, label: 'MACD crosses positive', detail });
    if (ok) side = 'buy';
  }
  // Golden cross EVENT (SMA50 crosses above SMA200).
  if (r.golden_cross) {
    const have = snap.sma50 != null && snap.sma200 != null && snap.prev.sma50 != null && snap.prev.sma200 != null;
    const ok = have && snap.prev.sma50! <= snap.prev.sma200! && snap.sma50! > snap.sma200!;
    const detail = !have ? 'insufficient data (needs 200 daily bars)'
      : ok ? 'SMA50 crossed above SMA200 today'
      : snap.sma50! > snap.sma200! ? `SMA50 ${n(snap.sma50)} already > SMA200 ${n(snap.sma200)} (no fresh cross)`
      : `SMA50 ${n(snap.sma50)} ≤ SMA200 ${n(snap.sma200)} (no cross)`;
    checks.push({ kind: 'trigger', ok, label: 'golden cross (SMA50×SMA200)', detail });
    if (ok) side = 'buy';
  }
  // Death cross EVENT (SMA50 crosses below SMA200) — bearish (long put).
  if (r.death_cross) {
    const have = snap.sma50 != null && snap.sma200 != null && snap.prev.sma50 != null && snap.prev.sma200 != null;
    const ok = have && snap.prev.sma50! >= snap.prev.sma200! && snap.sma50! < snap.sma200!;
    const detail = !have ? 'insufficient data'
      : ok ? 'SMA50 crossed below SMA200 today'
      : `SMA50 ${n(snap.sma50)} vs SMA200 ${n(snap.sma200)} (no cross)`;
    checks.push({ kind: 'trigger', ok, label: 'death cross (SMA50×SMA200)', detail });
    if (ok) side = 'sell';
  }
  // Bollinger reversion.
  if (r.bollinger_lower) {
    const have = snap.last != null && !!snap.bollinger;
    const ok = have && snap.last! < snap.bollinger!.lower;
    checks.push({ kind: 'trigger', ok, label: 'price < lower Bollinger', detail: !have ? 'insufficient data' : `price ${n(snap.last)} ${ok ? '<' : '≥'} lower band ${n(snap.bollinger!.lower)}` });
    if (ok) side = 'buy';
  }
  if (r.bollinger_upper) {
    const have = snap.last != null && !!snap.bollinger;
    const ok = have && snap.last! > snap.bollinger!.upper;
    checks.push({ kind: 'trigger', ok, label: 'price > upper Bollinger', detail: !have ? 'insufficient data' : `price ${n(snap.last)} ${ok ? '>' : '≤'} upper band ${n(snap.bollinger!.upper)}` });
    if (ok) side = 'sell';
  }
  // Donchian breakout / breakdown vs the PRIOR 20-bar channel (no same-bar look-ahead).
  if (r.breakout_high) {
    const have = snap.last != null && !!snap.donchian20Prior;
    const ok = have && snap.last! >= snap.donchian20Prior!.high;
    checks.push({ kind: 'trigger', ok, label: 'breakout > prior 20-bar high', detail: !have ? 'insufficient data' : `price ${n(snap.last)} ${ok ? '≥' : '<'} prior high ${n(snap.donchian20Prior!.high)}` });
    if (ok) side = 'buy';
  }
  if (r.breakdown_low) {
    const have = snap.last != null && !!snap.donchian20Prior;
    const ok = have && snap.last! <= snap.donchian20Prior!.low;
    checks.push({ kind: 'trigger', ok, label: 'breakdown < prior 20-bar low', detail: !have ? 'insufficient data' : `price ${n(snap.last)} ${ok ? '≤' : '>'} prior low ${n(snap.donchian20Prior!.low)}` });
    if (ok) side = 'sell';
  }
  // Momentum threshold (% change on the day).
  if (r.change_above != null) {
    const v = snap.change1d; const ok = v != null && v > r.change_above;
    checks.push({ kind: 'trigger', ok, label: `daily change > ${r.change_above}%`, detail: v == null ? 'no data' : `${n(v)}% ${ok ? '>' : '≤'} ${r.change_above}%` });
    if (ok) side = 'buy';
  }
  if (r.change_below != null) {
    const v = snap.change1d; const ok = v != null && v < r.change_below;
    checks.push({ kind: 'trigger', ok, label: `daily change < ${r.change_below}%`, detail: v == null ? 'no data' : `${n(v)}% ${ok ? '<' : '≥'} ${r.change_below}%` });
    if (ok) side = 'sell';
  }
  // Multi-day momentum (5-day / 10-day % change) — triggers.
  if (r.mom5_above != null) {
    const v = snap.mom5; const ok = v != null && v > r.mom5_above;
    checks.push({ kind: 'trigger', ok, label: `5-day change > ${r.mom5_above}%`, detail: v == null ? 'no data' : `${n(v)}% ${ok ? '>' : '≤'} ${r.mom5_above}%` });
    if (ok) side = 'buy';
  }
  if (r.mom5_below != null) {
    const v = snap.mom5; const ok = v != null && v < r.mom5_below;
    checks.push({ kind: 'trigger', ok, label: `5-day change < ${r.mom5_below}%`, detail: v == null ? 'no data' : `${n(v)}% ${ok ? '<' : '≥'} ${r.mom5_below}%` });
    if (ok) side = 'sell';
  }
  if (r.mom10_above != null) {
    const v = snap.mom10; const ok = v != null && v > r.mom10_above;
    checks.push({ kind: 'trigger', ok, label: `10-day change > ${r.mom10_above}%`, detail: v == null ? 'no data' : `${n(v)}% ${ok ? '>' : '≤'} ${r.mom10_above}%` });
    if (ok) side = 'buy';
  }
  if (r.mom10_below != null) {
    const v = snap.mom10; const ok = v != null && v < r.mom10_below;
    checks.push({ kind: 'trigger', ok, label: `10-day change < ${r.mom10_below}%`, detail: v == null ? 'no data' : `${n(v)}% ${ok ? '<' : '≥'} ${r.mom10_below}%` });
    if (ok) side = 'sell';
  }
  // Consecutive-day streaks — triggers. (Require ≥1 so a misconfigured 0 can't fire every bar.)
  if (r.consec_up != null && r.consec_up >= 1) {
    const ok = snap.consecUp >= r.consec_up;
    checks.push({ kind: 'trigger', ok, label: `${r.consec_up}+ up days in a row`, detail: `${snap.consecUp} consecutive up day(s)` });
    if (ok) side = 'buy';
  }
  if (r.consec_down != null && r.consec_down >= 1) {
    const ok = snap.consecDown >= r.consec_down;
    checks.push({ kind: 'trigger', ok, label: `${r.consec_down}+ down days in a row`, detail: `${snap.consecDown} consecutive down day(s)` });
    if (ok) side = 'sell';
  }
  // RSI crossing a level (event, not state) — triggers.
  if (r.rsi_cross_above != null) {
    const have = snap.rsi14 != null && snap.prev.rsi14 != null;
    const ok = have && snap.prev.rsi14! <= r.rsi_cross_above && snap.rsi14! > r.rsi_cross_above;
    checks.push({ kind: 'trigger', ok, label: `RSI crosses up through ${r.rsi_cross_above}`, detail: !have ? 'no RSI data' : ok ? `RSI ${n(snap.prev.rsi14)}→${n(snap.rsi14)} crossed ${r.rsi_cross_above}` : `RSI ${n(snap.rsi14)} (no upward cross of ${r.rsi_cross_above})` });
    if (ok) side = 'buy';
  }
  if (r.rsi_cross_below != null) {
    const have = snap.rsi14 != null && snap.prev.rsi14 != null;
    const ok = have && snap.prev.rsi14! >= r.rsi_cross_below && snap.rsi14! < r.rsi_cross_below;
    checks.push({ kind: 'trigger', ok, label: `RSI crosses down through ${r.rsi_cross_below}`, detail: !have ? 'no RSI data' : ok ? `RSI ${n(snap.prev.rsi14)}→${n(snap.rsi14)} crossed ${r.rsi_cross_below}` : `RSI ${n(snap.rsi14)} (no downward cross of ${r.rsi_cross_below})` });
    if (ok) side = 'sell';
  }
  // ── FILTERS (gates that must hold) ──
  if (r.above_ema50) {
    const have = snap.last != null && snap.ema50 != null;
    const ok = have && snap.last! > snap.ema50!;
    checks.push({ kind: 'filter', ok, label: 'price > EMA50 (uptrend)', detail: !have ? 'insufficient data' : `price ${n(snap.last)} ${ok ? '>' : '≤'} EMA50 ${n(snap.ema50)}` });
  }
  if (r.below_ema50) {
    const have = snap.last != null && snap.ema50 != null;
    const ok = have && snap.last! < snap.ema50!;
    checks.push({ kind: 'filter', ok, label: 'price < EMA50 (downtrend)', detail: !have ? 'insufficient data' : `price ${n(snap.last)} ${ok ? '<' : '≥'} EMA50 ${n(snap.ema50)}` });
  }
  if (r.near_high20 != null) {
    const hi = snap.donchian20Prior?.high ?? null;
    const have = snap.last != null && hi != null && hi > 0;
    const distPct = have ? ((hi! - snap.last!) / hi!) * 100 : null; // 0 = at high, positive = below, negative = ABOVE (breakout)
    // "Within X% of the high" includes being AT or ABOVE it — so this confirms breakouts
    // rather than blocking them. (No lower bound: a fresh high is 0% or negative distance.)
    const ok = distPct != null && distPct <= r.near_high20;
    checks.push({ kind: 'filter', ok, label: `at/within ${r.near_high20}% of 20-day high`, detail: distPct == null ? 'insufficient data' : distPct <= 0 ? `at/above the 20-day high (${n(-distPct)}% above)` : `${n(distPct)}% below 20-day high (need ≤ ${r.near_high20}%)` });
  }
  if (r.near_low20 != null) {
    const lo = snap.donchian20Prior?.low ?? null;
    const have = snap.last != null && lo != null && lo > 0;
    const distPct = have ? ((snap.last! - lo!) / lo!) * 100 : null; // 0 = at low, positive = above, negative = BELOW (breakdown)
    const ok = distPct != null && distPct <= r.near_low20;
    checks.push({ kind: 'filter', ok, label: `at/within ${r.near_low20}% of 20-day low`, detail: distPct == null ? 'insufficient data' : distPct <= 0 ? `at/below the 20-day low (${n(-distPct)}% below)` : `${n(distPct)}% above 20-day low (need ≤ ${r.near_low20}%)` });
  }
  if (r.vol_expand != null) {
    const have = snap.change1d != null && snap.dailyVol != null && snap.dailyVol! > 0;
    const ratio = have ? Math.abs(snap.change1d!) / snap.dailyVol! : null;
    const ok = ratio != null && ratio >= r.vol_expand;
    checks.push({ kind: 'filter', ok, label: `move ≥ ${r.vol_expand}× normal vol`, detail: ratio == null ? 'insufficient data' : `today's move is ${n(ratio)}× the 20-day daily vol (need ≥ ${r.vol_expand}×)` });
  }

  // FIRE LOGIC: every specified filter must hold AND >= the required number of triggers fire.
  const triggers = checks.filter((c) => c.kind === 'trigger');
  const filters = checks.filter((c) => c.kind === 'filter');
  const triggersMet = triggers.filter((c) => c.ok);
  const filtersFailed = filters.filter((c) => !c.ok);
  const need = r.require_all ? triggers.length : (r.min_matches || 1);
  const filtersOk = filtersFailed.length === 0;
  const fired = triggers.length > 0 && filtersOk && triggersMet.length >= need;
  const matched = checks.filter((c) => c.ok).map((c) => c.detail);

  // Plain-English summary of the decision.
  let why: string;
  if (triggers.length === 0) why = 'No trigger rules configured — this bot cannot fire.';
  else if (fired) why = `Fired: ${triggersMet.map((c) => c.label).join(' + ')}.`;
  else if (!filtersOk) why = `Blocked by trend filter — ${filtersFailed.map((c) => c.detail).join('; ')}.`;
  else {
    const unmet = triggers.filter((c) => !c.ok).map((c) => c.detail).join('; ');
    why = `No entry: needs ${need} trigger${need > 1 ? 's' : ''}, ${triggersMet.length} met. ${unmet}`;
  }

  return { fired, matched, side, checks, why };
}

export async function evaluateBot(botRow: any): Promise<any> {
  // QuickBots have their own multi-play (calls AND puts, DTE-scaled) evaluator.
  const act = botRow.action && (typeof botRow.action === 'string' ? safeParseJSON(botRow.action) : botRow.action);
  if (act?._quickbot) {
    const { evaluateQuickbot } = await import('../quickbot.js');
    return evaluateQuickbot(botRow);
  }
  const bot = parseBot(botRow);
  const results: any[] = [];
  for (const symbolRaw of bot.symbols) {
    const symbol = String(symbolRaw).toUpperCase();
    if (isCryptoSymbol(symbol)) {
      results.push({ symbol, skipped: 'crypto blocked' });
      continue;
    }
    const closes = await closesFor(symbol);
    const snap = snapshot(closes);
    const ev = evalRules(bot.rules, snap);

    let aiOk = true;
    let ai: any = null;
    if (ev.fired && bot.ai_gate?.enabled && aiReady()) {
      try {
        ai = await analyzeSymbol(symbol, `Bot "${bot.name}" rule fired: ${ev.matched.join(', ')}.`);
        const minConv = bot.ai_gate.min_conviction ?? 0.5;
        aiOk = (ai.conviction ?? 0) >= minConv && (ev.side === 'buy' ? (ai.sentiment ?? 0) > 0 : true);
      } catch (e: any) {
        aiOk = false;
        ai = { error: e?.message };
      }
    }

    await exec(
      `INSERT INTO signals (bot_id, symbol, timeframe, fired, matched, snapshot)
       VALUES (:bid,:sym,'1d',:fired,CAST(:matched AS JSON),CAST(:snap AS JSON))`,
      {
        bid: bot.id,
        sym: symbol,
        fired: ev.fired ? 1 : 0,
        matched: JSON.stringify({ rules: ev.matched, why: ev.why, checks: ev.checks, ai }),
        snap: JSON.stringify(snap),
      },
    );

    if (ev.fired && aiOk) {
      const side = (bot.action?.side as 'buy' | 'sell') || ev.side;
      // RE-ENTRY POLICY: the worker re-evaluates every 120s on DAILY bars and a fired daily
      // signal holds all session — so allow a few entries/day SPACED by a cooldown (a persistent
      // signal becomes 3–5 distinct adds) instead of one-and-done. Per-bot tunable; see reentryGate.
      const env = await getTradingEnv();
      const lockKey = `${bot.id}:${symbol}:${side}`;
      if (!claimEntrySlot(lockKey)) {
        results.push({ symbol, fired: true, checks: ev.checks, why: `${ev.why} Entry in-flight (another pass) — skipped.` });
        continue;
      }
      try {
        const skip = await reentryGate({ botId: bot.id, symbol, side, env, riskCfg: bot.risk });
        if (skip) {
          results.push({ symbol, fired: true, checks: ev.checks, why: `${ev.why} ${skip}` });
          continue;
        }
        const isOption = (bot.asset_class || 'equity').toLowerCase() === 'option';
        const draft: OrderDraft = {
          env: bot.env,
          symbol,
          asset_class: bot.asset_class || 'equity',
          side,
          qty: Number(bot.action?.qty ?? 1),
          order_type: bot.action?.order_type || 'market',
          limit_price: bot.action?.limit_price,
          source: 'bot',
          bot_id: bot.id,
        };
        if (isOption) {
          // Option bots MUST carry the contract spec so executeDraft resolves a REAL contract
          // and sizes off its PREMIUM. Two bugs lived here: (1) these fields were dropped, so the
          // option never resolved; (2) est_price was seeded with snap.last — the UNDERLYING price —
          // which the risk engine then multiplied ×100 (e.g. QQQ $723×100 = $72k for one contract,
          // vetoing every order). Pass the spec; leave est_price for the resolved contract's mid.
          draft.option_type = (bot.action?.option_type === 'put' ? 'put' : 'call');
          draft.strike_target = bot.action?.strike_target || 'atm';
          // Resolve DTE → expiration date at EVAL time (never bake a date at bot creation).
          draft.expiration = Number.isFinite(Number(bot.action?._dte))
            ? dteToExpiration(Number(bot.action._dte))
            : (bot.action?.expiration || 'weekly');
          if (Number(bot.action?.est_price) > 0) draft.est_price = Number(bot.action.est_price);
        } else {
          draft.est_price = snap.last ?? bot.action?.est_price;
        }
        // SIZING: turn the effective dollar amount per trade (bot override, else the global
        // trade default) into whole shares/contracts. A bot that deliberately pins its own
        // quantity keeps it (action.qty_pinned), but the min/max per trade still apply.
        const sized = await sizeDraft(draft, { risk: bot.risk, env, pinnedQty: bot.action?.qty_pinned ? Number(bot.action?.qty ?? 1) : null });
        if (!sized.ok) {
          results.push({ symbol, fired: true, checks: ev.checks, why: `${ev.why} Not sized: ${sized.reason}.` });
          continue;
        }
        const exec1 = await executeDraft(draft, {
          modeOverride: bot.mode,
          rationale: `bot:${bot.name} ${ev.matched.join(', ')}${ai ? ` | AI conv ${ai.conviction}` : ''}`,
        });
        results.push({ symbol, fired: true, action: exec1.action, status: exec1.status, reason: exec1.reason, checks: ev.checks, why: ev.why });
      } finally {
        releaseEntrySlot(lockKey);
      }
    } else {
      // Not fired (or AI gate blocked an otherwise-fired signal). Record the full
      // breakdown + plain-English reason so the user can see exactly why.
      const why = ev.fired && !aiOk
        ? `Rules fired but Claude gate blocked it${ai?.conviction != null ? ` (conviction ${ai.conviction} < ${bot.ai_gate?.min_conviction ?? 0.5})` : ''}.`
        : ev.why;
      results.push({ symbol, fired: ev.fired, aiOk, checks: ev.checks, why, last: snap.last ?? null });
    }
  }

  await exec('UPDATE bots SET last_evaluated_at=NOW(), last_result=CAST(:r AS JSON) WHERE id=:id AND env=:env', {
    r: JSON.stringify(results),
    id: bot.id,
    env: bot.env,
  });
  await audit('bot.eval', `evaluated ${bot.name}`, { id: bot.id, results });
  return results;
}

export async function evaluateAllEnabledBots(): Promise<any[]> {
  // Only the ACTIVE account's fleet ever runs. A bot seeded for another environment is
  // inert until you switch to that account (its orders would hit the wrong broker).
  const env = await getTradingEnv();
  const bots = await q<any>('SELECT * FROM bots WHERE enabled=1 AND env=:env', { env });
  // FOCUS MODE: concentrate all enabled bots on the single focus ticker. We override
  // the in-memory symbol list only (the saved bot config is untouched and restored
  // the moment focus is turned off).
  const { getFocus } = await import('../focus.js');
  const focus = await getFocus();
  const out: any[] = [];
  for (let b of bots) {
    try {
      if (focus.enabled) b = { ...b, symbols: JSON.stringify([focus.symbol]) };
      out.push({ bot: b.name, results: await evaluateBot(b), focused: focus.enabled ? focus.symbol : undefined });
    } catch (e: any) {
      out.push({ bot: b.name, error: e?.message || String(e) });
    }
  }
  return out;
}
