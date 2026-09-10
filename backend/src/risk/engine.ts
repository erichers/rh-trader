import { config, HARD_BLOCKED_ASSET_CLASSES, isCryptoSymbol, isLiveEnv, type Mode, type TradingEnv } from '../config.js';
import { q, exec, getKillSwitch, getSetting, setSetting, getTradingEnv, getRiskLimits } from '../db.js';
import { evaluateSymbolCaps, openSymbolExposureUsd, reservedBuyNotional, splitInflightBuys, todayEt, type ExposureOrder } from './exposure.js';

/** Options trade in 100-share contracts; quoted premium is per share. */
const CONTRACT_MULT = 100;

export type OrderDraft = {
  symbol: string;
  env?: TradingEnv;         // the account this draft was built for; execution refuses if the active env differs
  asset_class?: string;
  side: 'buy' | 'sell';
  qty: number;
  order_type?: 'market' | 'limit' | 'stop' | 'stop_limit';
  limit_price?: number;
  stop_price?: number;
  est_price?: number; // best estimate of fill price for sizing math
  source?: 'manual' | 'bot' | 'ai';
  bot_id?: number;
  // Options (long only): buying a call = bullish, buying a put = bearish.
  option_type?: 'call' | 'put';
  strike_target?: 'itm' | 'atm' | 'otm';
  expiration?: 'weekly' | 'monthly' | string; // or explicit YYYY-MM-DD
  // A concrete resolved contract (set by executeDraft before risk so sizing is real).
  // `instrumentId` (when present) is the broker's native contract id (Robinhood) so
  // placement uses the exact resolved contract without re-looking it up.
  _contract?: { occSymbol: string; type: 'call' | 'put'; strike: number; expiration: string; mid?: number | null; readable?: string; instrumentId?: string };
  // QuickBot per-play overrides: DTE-scaled exits (monitor) + position cap (risk sizing).
  // `tag` is a stable ASCII contract identity (e.g. "call-7") used for same-day dedup.
  _play?: { name?: string; tag?: string; dte?: number; tp?: number; sl?: number; trail?: number; maxPositionUsd?: number };
  // Watch stubs. When true (or the loaded bot is observe-only), executeDraft must
  // not insert an order row. Re-checked from the bot row so a missing flag cannot bypass.
  _observe_only?: boolean;
};

export type RiskResult = {
  ok: boolean;
  reason: string;
  checks: Record<string, { pass: boolean; detail: string }>;
  computed: Record<string, number>;
};

export type ExecAction = 'observe' | 'stage' | 'execute' | 'veto';
export type Decision = {
  action: ExecAction;
  risk: RiskResult;
  mode: Mode;
};

export type Caps = {
  maxPositionUsd: number;
  maxConcentrationPct: number;
  maxDailyLossPct: number;
  maxOrdersPerDay: number;
  overrideActive: boolean;
};

/** The money caps that actually apply to one order, given the global limits, the bot's own
 *  risk config and (for a QuickBot) the play's DTE band. Extracted from riskCheck so the
 *  SIZER uses the identical ceiling the gate will enforce — one source of truth, no drift.
 *  Semantics are unchanged: normally the TIGHTER of global and the bot's max_position_usd
 *  applies; a bot with risk.override=true replaces the sizing limits with its OWN, CLAMPED
 *  so no bot can disable a safety breaker; a play can only tighten further. */
export function resolveCaps(botRisk: any, play: OrderDraft['_play'] | undefined, lim: { maxPositionUsd: number; maxConcentrationPct: number; maxDailyLossPct: number; maxOrdersPerDay: number }): Caps {
  let maxPositionUsd = lim.maxPositionUsd;
  let maxConcentrationPct = lim.maxConcentrationPct;
  let maxDailyLossPct = lim.maxDailyLossPct;
  let maxOrdersPerDay = lim.maxOrdersPerDay;
  let overrideActive = false;
  const r = typeof botRisk === 'string' ? safeParse(botRisk) : botRisk;
  if (r?.override) {
    overrideActive = true;
    // CLAMP the override to safe bounds — a bot must never be able to disable the safety
    // breakers (e.g. set daily-loss to 100% so it never trips, or remove the concentration cap).
    const clamp = (v: any, lo: number, hi: number, fallback: number) => (Number(v) > 0 ? Math.min(hi, Math.max(lo, Number(v))) : fallback);
    maxPositionUsd = clamp(r.max_position_usd, 50, 1_000_000_000, maxPositionUsd);
    maxConcentrationPct = clamp(r.max_concentration_pct, 1, 95, maxConcentrationPct); // never 100% (no cap)
    maxDailyLossPct = clamp(r.max_daily_loss_pct, 1, 50, maxDailyLossPct);            // breaker must trip before half gone
    maxOrdersPerDay = clamp(r.max_orders_per_day, 1, 1000, maxOrdersPerDay);
  } else if (r && Number(r.max_position_usd) > 0) {
    maxPositionUsd = Math.min(maxPositionUsd, Number(r.max_position_usd));
  }
  // A QuickBot play carries its own DTE-scaled position cap (smaller for 1-day, larger
  // for 7-day). It can only TIGHTEN within the bot's override budget, never exceed it.
  if (play && Number(play.maxPositionUsd) > 0) maxPositionUsd = Math.min(maxPositionUsd, Number(play.maxPositionUsd));
  return { maxPositionUsd, maxConcentrationPct, maxDailyLossPct, maxOrdersPerDay, overrideActive };
}

/** Pure deterministic risk gate. Crypto and the kill switch are hard blocks.
 *  `env` scopes all account/position lookups to the ACTIVE trading environment so
 *  paper data can never loosen a live-account check (and vice versa).
 *  `mode` (the EFFECTIVE execution mode for this order): in `full_auto` the SOFT sizing
 *  throttles — position size, concentration, orders/day — are bypassed (still computed &
 *  shown, just not vetoed) so a fully-autonomous bot can act freely. The HARD rails always
 *  hold: kill switch, no-crypto, asset allowlist, no-short / no-naked-write, and the
 *  daily-loss circuit breaker (the one protection that stops a runaway from draining it). */
export async function riskCheck(draft: OrderDraft, env?: TradingEnv, mode?: Mode): Promise<RiskResult> {
  const checks: RiskResult['checks'] = {};
  const computed: Record<string, number> = {};
  const t = config.trading;
  const lim = await getRiskLimits(); // adjustable from the UI (overrides .env defaults)
  const ac = (draft.asset_class || 'equity').toLowerCase();
  if (!env) env = await getTradingEnv();
  const mult = ac === 'option' ? CONTRACT_MULT : 1; // option premium is per-share; contracts are ×100
  // Full-auto bypasses the SOFT sizing caps only (never the hard rails / daily-loss breaker).
  const fullAuto = mode === 'full_auto';
  computed.full_auto = fullAuto ? 1 : 0;

  // Per-bot money limit override (set in the bot wizard). Normally the TIGHTER of the
  // global cap and the bot's own max_position_usd applies. A QuickBot with
  // risk.override=true is the exception — it sets its OWN sizing limits (position,
  // concentration, daily-loss, orders/day) that REPLACE the global ones (hard blocks
  // like crypto/kill-switch/no-short still always apply).
  let botRisk: any = null;
  if (draft.bot_id) {
    // env-scoped: a bot from another account can never relax THIS account's limits
    // (no match => the global, tighter limits stand — fail-closed).
    const [bot] = await q<{ risk: any }>('SELECT risk FROM bots WHERE id=:id AND env=:env', { id: draft.bot_id, env });
    botRisk = bot?.risk ? (typeof bot.risk === 'string' ? safeParse(bot.risk) : bot.risk) : null;
  }
  const caps = resolveCaps(botRisk, draft._play, lim);
  const { maxConcentrationPct, maxDailyLossPct, maxOrdersPerDay, overrideActive } = caps;
  const maxPositionUsd = caps.maxPositionUsd;
  computed.override_active = overrideActive ? 1 : 0;

  // 1. Kill switch — blocks NEW exposure (buys) but NEVER a close-only SELL. Exits are
  //    your downside protection; freezing them during a selloff is the opposite of safe.
  //    A sell is already constrained to closing a held long (no_short / no naked write),
  //    so allowing it under the kill switch can only REDUCE risk.
  const killed = await getKillSwitch();
  const killBlocks = killed && draft.side === 'buy';
  checks.kill_switch = { pass: !killBlocks, detail: killed ? (draft.side === 'sell' ? 'engaged — exit allowed (close-only)' : 'kill switch engaged') : 'off' };

  // 2. NO CRYPTO — hard block (asset class + symbol heuristic).
  const cryptoByClass = HARD_BLOCKED_ASSET_CLASSES.includes(ac);
  const cryptoBySymbol = isCryptoSymbol(draft.symbol);
  const isCrypto = cryptoByClass || cryptoBySymbol;
  checks.no_crypto = {
    pass: !isCrypto,
    detail: isCrypto ? `crypto is permanently blocked (${draft.symbol}/${ac})` : 'ok',
  };

  // 3. Asset-class allowlist.
  const allowed = t.allowedAssetClasses.includes(ac);
  checks.asset_class = {
    pass: allowed,
    detail: allowed ? ac : `'${ac}' not in allowlist [${t.allowedAssetClasses.join(',')}]`,
  };

  // 4. Position size cap (USD). Options are ×100 (contract multiplier) so the
  //    cap actually applies to the real dollar cost, not per-share premium.
  const price = draft.est_price ?? draft.limit_price ?? 0;
  const notional = price > 0 ? price * draft.qty * mult : 0;
  computed.notional_usd = Math.round(notional * 100) / 100;
  // An option BUY that couldn't be priced (no contract / no quote) must FAIL the size
  // cap, not pass via notional===0 — otherwise an unpriceable order slips through.
  const unpriceableOptionBuy = ac === 'option' && draft.side === 'buy' && !(notional > 0);
  const sizeWithinCap = !unpriceableOptionBuy && (draft.side === 'sell' || notional === 0 || notional <= maxPositionUsd);
  computed.max_position_usd_limit = maxPositionUsd;

  // 5. Same-symbol book (all bots) + concentration vs equity.
  //    Per-ticket math is not enough: three META tickets each under the $10k ticket
  //    cap stacked ~$13.7k. Sum position + in-flight + same-cycle reservations here.
  const [acct] = await q<{ equity: number }>(
    'SELECT equity FROM accounts WHERE env=:env ORDER BY updated_at DESC LIMIT 1', { env },
  );
  const equity = Number(acct?.equity ?? 0);
  computed.portfolio_equity = equity;
  let concentrationOk = true;
  let concDetail = 'no equity snapshot — skipped';
  let concFailClosed = false;
  let aggregatePositionOk = sizeWithinCap;
  let positionDetail = sizeWithinCap
    ? `${computed.notional_usd} <= ${maxPositionUsd}`
    : unpriceableOptionBuy
      ? 'option buy not priceable — cannot size'
      : `${computed.notional_usd} > ${maxPositionUsd}`;

  if (isLiveEnv(env) && draft.side === 'buy' && !(equity > 0)) {
    concentrationOk = false;
    concFailClosed = true;
    concDetail = 'live account equity unknown/zero — fail-closed (fund + Sync the account first)';
  } else if (draft.side === 'buy' && notional > 0) {
    const [pos] = await q<{ mv: number }>(
      'SELECT COALESCE(market_value,0) mv FROM positions WHERE symbol=:s AND env=:env ORDER BY updated_at DESC LIMIT 1',
      { s: draft.symbol, env },
    );
    // Sum in JS — do not rely on MySQL 8 JSON operators (MAMP 5.7 / MariaDB diverge,
    // and a failed extract used to count in-flight market buys as $0).
    const inflight = await q<ExposureOrder>(
      `SELECT qty, filled_price, limit_price, asset_class, status, raw, created_at
       FROM orders WHERE symbol=:s AND env=:env AND side='buy'
         AND status IN ('placed','filled','staged')`,
      { s: draft.symbol, env },
    );
    const { pendingUsd, todayFilledUsd } = splitInflightBuys(inflight, todayEt());
    const reservedUsd = reservedBuyNotional(env, draft.symbol);
    const openUsd = openSymbolExposureUsd({
      positionMv: Number(pos?.mv ?? 0),
      todayFilledUsd,
      pendingUsd,
      reservedUsd,
    });
    const caps = evaluateSymbolCaps({
      side: draft.side,
      ticketNotional: notional,
      openUsd,
      equity,
      maxPositionUsd,
      maxConcentrationPct,
    });
    computed.symbol_open_usd = Math.round(openUsd * 100) / 100;
    computed.symbol_stacked_usd = caps.stackedUsd;
    computed.pending_usd = Math.round(pendingUsd * 100) / 100;
    computed.reserved_usd = Math.round(reservedUsd * 100) / 100;
    aggregatePositionOk = !unpriceableOptionBuy && caps.ticketOk && caps.positionOk;
    positionDetail = unpriceableOptionBuy
      ? 'option buy not priceable — cannot size'
      : `${caps.ticketDetail}; ${caps.positionDetail}${overrideActive ? ' (bot override)' : ''}`;
    if (equity > 0) {
      computed.concentration_pct = caps.concentrationPct ?? 0;
      concentrationOk = caps.concentrationOk;
      concDetail = `${caps.concentrationDetail}${overrideActive ? ' (bot override)' : ''}`;
    } else {
      concDetail = 'no equity snapshot — skipped';
    }
  }
  // Full-auto: don't let SOFT sizing veto (still surfaced). Hard rails + daily-loss stay.
  // EXCEPTION: live-equity fail-closed is a safety veto — full-auto must never bypass it.
  // Auto / cautious keep the stacked symbol book (the META pile-on).
  const sizeOk = aggregatePositionOk || (fullAuto && !unpriceableOptionBuy);
  checks.max_position_usd = {
    pass: sizeOk,
    detail: aggregatePositionOk
      ? positionDetail
      : `${positionDetail}${fullAuto && !unpriceableOptionBuy ? ' — bypassed (full-auto)' : ''}`,
  };
  if (!concentrationOk && fullAuto && !concFailClosed) { concDetail = `${concDetail} — bypassed (full-auto)`; concentrationOk = true; }
  checks.concentration = { pass: concentrationOk, detail: concDetail };

  // 6. No short selling — long-only. A sell may not exceed the held quantity
  //    (equity OR option), scoped to the active env. You can only close a long.
  let heldQty = 0;
  if (draft.side === 'sell') {
    if (ac === 'option') {
      // An option sell must be covered by the EXACT held contract (occ_symbol), never
      // by shares or a different contract on the same underlying. If we can't identify
      // the concrete contract, heldQty stays 0 → the sell fails closed (no naked write).
      const occ = draft._contract?.occSymbol || '';
      if (occ) {
        const [held] = await q<{ qty: number }>(
          "SELECT COALESCE(SUM(qty),0) qty FROM positions WHERE env=:env AND asset_class='option' AND occ_symbol=:occ",
          { env, occ },
        );
        heldQty = Number(held?.qty ?? 0);
      }
      computed.held_contracts = heldQty;
    } else {
      // Shares = anything not an option (equity/us_equity/etf).
      const [held] = await q<{ qty: number }>(
        "SELECT COALESCE(SUM(qty),0) qty FROM positions WHERE symbol=:s AND env=:env AND asset_class<>'option'",
        { s: draft.symbol, env },
      );
      heldQty = Number(held?.qty ?? 0);
    }
    computed.held_qty = heldQty;
    const noShort = draft.qty <= heldQty + 1e-9;
    checks.no_short = {
      pass: noShort,
      detail: noShort ? `selling ${draft.qty} of ${heldQty} held` : `cannot short: sell ${draft.qty} > held ${heldQty}`,
    };
  } else {
    checks.no_short = { pass: true, detail: 'buy' };
  }

  // No naked option WRITING. Selling to CLOSE a held long (held >= qty) is allowed
  // for any source; selling-to-open (qty exceeds held contracts) is a naked write
  // and is blocked for everyone — long-only. (Covered calls vs shares stay manual.)
  const nakedWrite = ac === 'option' && draft.side === 'sell' && draft.qty > heldQty + 1e-9;
  checks.no_option_write = {
    pass: !nakedWrite,
    detail: nakedWrite ? 'naked option write blocked (sell exceeds held contracts — long-only)' : 'ok',
  };

  // 7. Daily-loss circuit breaker — real equity drawdown vs the day's start equity
  //    (snapshotted per env on first check each market day).
  let dailyOk = true; let dailyDetail = 'no equity snapshot — skipped';
  if (isLiveEnv(env) && draft.side === 'buy' && !(equity > 0)) {
    dailyOk = false; dailyDetail = 'live account equity unknown/zero — fail-closed (fund + Sync first)';
  } else if (equity > 0) {
    // Key by the ET trading day so the baseline resets at the US market day, not UTC midnight.
    const etDay = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
    const dayKey = `day_start_equity:${env}:${etDay}`;
    let startEq = Number(await getSetting<number>(dayKey, 0));
    if (!startEq) { startEq = equity; await setSetting(dayKey, equity); }
    const lossPct = startEq > 0 ? ((startEq - equity) / startEq) * 100 : 0;
    computed.daily_loss_pct = Math.round(lossPct * 100) / 100;
    dailyOk = lossPct < maxDailyLossPct;
    dailyDetail = `${computed.daily_loss_pct}% drawdown vs cap ${maxDailyLossPct}% (start ${Math.round(startEq)})`;
  }
  checks.daily_loss = { pass: dailyOk, detail: dailyDetail };

  // 8. Orders-per-day throttle — BUYS only (never block an exit), scoped to env.
  if (draft.side === 'buy') {
    const [cnt] = await q<{ n: number }>(
      "SELECT COUNT(*) n FROM orders WHERE status IN ('placed','filled') AND side='buy' AND env=:env AND created_at >= CURDATE()",
      { env },
    );
    const placedToday = Number(cnt?.n ?? 0);
    computed.orders_today = placedToday;
    const throttleOk = placedToday < maxOrdersPerDay;
    checks.orders_per_day = { pass: throttleOk || fullAuto, detail: `${placedToday}/${maxOrdersPerDay} buys today${overrideActive ? ' (bot override)' : ''}${!throttleOk && fullAuto ? ' — bypassed (full-auto)' : ''}` };
  } else {
    checks.orders_per_day = { pass: true, detail: 'sell/exit — not throttled' };
  }

  const failed = Object.entries(checks).filter(([, v]) => !v.pass);
  return {
    ok: failed.length === 0,
    reason: failed.length ? failed.map(([k, v]) => `${k}: ${v.detail}`).join('; ') : 'all checks passed',
    checks,
    computed,
  };
}

/** Combine risk + execution mode into a concrete action. */
export async function decideExecution(draft: OrderDraft, mode: Mode, env?: TradingEnv): Promise<Decision> {
  const risk = await riskCheck(draft, env, mode);
  let action: ExecAction;
  if (!risk.ok) action = 'veto';
  else if (mode === 'observe') action = 'observe';
  else if (mode === 'cautious') action = 'stage';
  else action = 'execute'; // auto | full_auto
  return { action, risk, mode };
}

function safeParse(s: string): any { try { return JSON.parse(s); } catch { return null; } }

export async function logRiskEvent(draft: OrderDraft, risk: RiskResult): Promise<void> {
  await exec(
    `INSERT INTO risk_events (symbol, side, qty, decision, reason, rules, computed, source, bot_id)
     VALUES (:symbol,:side,:qty,:decision,:reason,CAST(:rules AS JSON),CAST(:computed AS JSON),:source,:bot_id)`,
    {
      symbol: draft.symbol,
      side: draft.side,
      qty: draft.qty,
      decision: risk.ok ? 'allow' : 'veto',
      reason: risk.reason,
      rules: JSON.stringify(risk.checks),
      computed: JSON.stringify(risk.computed),
      source: draft.source || 'manual',
      bot_id: draft.bot_id ?? null,
    },
  );
}
