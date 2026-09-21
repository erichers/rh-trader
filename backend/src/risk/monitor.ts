import { q, exec, audit, getTradingEnv, getExitPolicy } from '../db.js';
import { raiseAlert } from '../alerts.js';
import { effectiveHardStop, exitReason, overnightFlattenReason, swingExitBand } from './exitpolicy.js';
import { isLeapsTrade, calendarDte, SHORT_DTE_RAILS } from './dte.js';
import {
  exitPlacementOutcome,
  heldZeroDecision,
  shouldRetryStuckNew,
  parsePendingExitOrderId,
  exitingReason,
  held0Reason,
  isTerminalFillStatus,
  mapBrokerOrderStatus,
  MAX_EXIT_ATTEMPTS,
} from './exitlifecycle.js';
import { alpacaPaper } from '../brokers/alpaca.js';
import { cancelBrokerOrder, getBrokerOrder } from '../brokers/index.js';
import { contractPrice, occToContract } from '../brokers/options.js';
import { getClock } from '../market/clock.js';
import type { OrderDraft } from './engine.js';
import { resolveBotRisk } from './sizing.js';
import { matchMonitorBot, occFromOrderRaw, planMonitorOpen, positiveId } from './monitorBot.js';
import { BOT_MATCH_BUY_SQL, BOT_MATCH_SIGNAL_SQL } from './monitorList.js';
import type { MonitorOrderCandidate, MonitorSignalCandidate } from './monitorBot.js';
import type { TradingEnv } from '../config.js';

// Live position monitor: enforces per-bot take-profit / stop-loss / trailing-stop on
// bot-opened positions — equity/ETF (priced off the underlying) AND options (priced
// off the contract premium via its OCC symbol). Exits route through executeDraft.
// A monitor stays OPEN until the broker reports a terminal fill (or the book is flat).

export async function createMonitor(draft: OrderDraft, orderId: number, entryPrice: number, env?: TradingEnv): Promise<void> {
  // Bot positions OR AI-opened positions get monitored. (AI drafts have no bot_id.)
  if (!draft.bot_id && draft.source !== 'ai') return;
  const ac = (draft.asset_class || 'equity').toLowerCase();
  const occ = ac === 'option' ? (draft._contract?.occSymbol || '') : '';
  if (ac === 'option' && !occ) return; // can't monitor an option without its concrete contract
  if (ac !== 'equity' && ac !== 'etf' && ac !== 'option') return;
  if (!env) env = await getTradingEnv();
  const existing = await openMonitorRow(env, draft.symbol, occ);
  const plan = planMonitorOpen({
    draftBotId: draft.bot_id,
    orderId,
    hasExisting: !!existing,
    existingBotId: existing?.bot_id ?? null,
  });
  if (plan.action === 'stamp' && existing) {
    await exec(
      'UPDATE position_monitors SET bot_id=:bid, order_id=COALESCE(order_id, :oid) WHERE id=:id AND bot_id IS NULL',
      { bid: plan.bot_id, oid: plan.order_id, id: existing.id },
    );
    await audit('monitor.bot_id', `stamped bot ${plan.bot_id} on open ${occ || draft.symbol}`, { id: existing.id, bot_id: plan.bot_id, order_id: plan.order_id });
    return;
  }
  if (plan.action === 'skip') return;
  const [bot] = draft.bot_id ? await q<{ risk: any }>('SELECT risk FROM bots WHERE id=:id AND env=:env', { id: draft.bot_id, env }) : [undefined as any];
  const r = bot?.risk ? (typeof bot.risk === 'string' ? safeParse(bot.risk) : bot.risk) : null;
  const p = draft._play;
  const eff = draft.bot_id ? await resolveBotRisk(r) : null;
  const swing = swingExitBand();
  let tp = p && p.tp != null ? Math.max(0, Number(p.tp) || 0) : (eff ? eff.take_profit_pct : Number(r?.take_profit_pct) || 0);
  let sl = Number(p?.sl) || (eff ? eff.stop_loss_pct : Number(r?.stop_loss_pct) || 0);
  let trail = Number(p?.trail) || (eff ? eff.trailing_stop_pct : Number(r?.trailing_stop_pct) || 0);
  if (!sl) sl = swing.sl;
  if (!trail) trail = swing.trail;
  if (tp == null || !(tp >= 0)) tp = swing.tp;
  sl = effectiveHardStop(sl);
  // Privileged 0–1 fills keep tight exits even if a wider band slipped onto the draft.
  const expISO = ac === 'option' ? (occToContract(occ)?.expiration || draft._contract?.expiration || '') : '';
  const entryDte = expISO ? calendarDte(expISO) : null;
  if (entryDte != null && entryDte <= 1) {
    sl = Math.min(sl, SHORT_DTE_RAILS.slMax);
    if (!(tp >= SHORT_DTE_RAILS.tpMin) || tp > SHORT_DTE_RAILS.tpMax) tp = 10;
    if (trail > SHORT_DTE_RAILS.trailMax) trail = SHORT_DTE_RAILS.trailMax;
  }
  let entry = entryPrice;
  if (!(entry > 0)) entry = (ac === 'option' ? (await contractPrice(occ)) : (await alpacaPaper.lastPrice(draft.symbol, { allowStale: true }))) || 0;
  if (!(entry > 0)) {
    await audit('monitor.create_failed', `no entry price for ${occ || draft.symbol} — position has NO stop monitor`, { order_id: orderId });
    await raiseAlert({ level: 'critical', source: 'monitor', title: `No stop monitor: ${occ || draft.symbol}`, body: `Order #${orderId} filled but no entry price could be resolved — the position is UNPROTECTED. Add a manual stop or re-sync.`, symbol: draft.symbol });
    return;
  }
  await exec(
    `INSERT INTO position_monitors (symbol, occ_symbol, env, account_number, asset_class, qty, entry_price, peak_price, trough_price, last_price, tp_pct, sl_pct, trail_pct, bot_id, order_id)
     VALUES (:s,:occ,:env,:acct,:ac,:qty,:entry,:entry,:entry,:entry,:tp,:sl,:trail,:bid,:oid)`,
    { s: draft.symbol, occ, env, acct: 'agentic', ac, qty: draft.qty, entry, tp, sl, trail, bid: plan.bot_id, oid: plan.order_id ?? orderId },
  );
  await audit('monitor.open', `watching ${occ || draft.symbol} from ${entry} on ${env} (tp ${tp}/sl ${sl}/trail ${trail})`, { bot_id: draft.bot_id ?? null, source: draft.source });
}

/** Evaluate open monitors FOR THE ACTIVE ENV ONLY; close on TP/SL/trailing.
 *  A monitor opened under paper must never fire a sell against a live account
 *  (or vice-versa) — so we only manage monitors whose env matches the active env. */
export async function checkMonitors(opts?: { reconcileOnly?: boolean }): Promise<{ checked: number; closed: number; attached: number; orphaned: number }> {
  const env = await getTradingEnv();
  const backfill = await backfillNullMonitorBotIds(env).catch(() => ({ open: new Map<number, number>(), newestClosed: null as any }));
  const attached = await ensureMonitorsForOpenPositions(env);
  const open = await q<any>("SELECT * FROM position_monitors WHERE status='open' AND (env=:env OR (env IS NULL AND :env='alpaca_paper'))", { env });

  const policy = await getExitPolicy();
  let minsToClose = Infinity, longGap = false;
  try {
    const clk = await getClock();
    if (clk.is_open && clk.next_close) {
      minsToClose = (Date.parse(clk.next_close) - Date.now()) / 60000;
      if (clk.next_open) longGap = (Date.parse(clk.next_open) - Date.parse(clk.next_close)) > 1.6 * 864e5;
    }
  } catch { /* clock unavailable → skip time-based flatten this cycle */ }
  const nearClose = minsToClose > 0 && minsToClose <= policy.closeBufferMin;

  let closed = 0;
  let orphaned = 0;
  for (const m of open) {
    if (!positiveId(m.bot_id) && backfill.open.has(Number(m.id))) m.bot_id = backfill.open.get(Number(m.id));
    const isOption = (m.asset_class || '').toLowerCase() === 'option';
    if (isOption && m.occ_symbol) {
      const c = occToContract(m.occ_symbol);
      const etToday = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
      if (c?.expiration && c.expiration < etToday) {
        await orphanMonitor(m, `contract expired ${c.expiration}`);
        orphaned++;
        continue;
      }
    }
    // reconcileOnly skips stop/trail/gain-lock. The worker must not set it
    // while any monitor is open — after-hours gaps still need the exit ladder.
    if (opts?.reconcileOnly) continue;

    const pendingId = parsePendingExitOrderId(m.reason, m.pending_exit_order_id);
    if (pendingId) {
      const settled = await settlePendingExit(m, pendingId, env);
      if (settled === 'closed') { closed++; continue; }
      if (settled === 'orphaned') { orphaned++; continue; }
      if (settled === 'pending' || settled === 'escalated') continue;
      // 'cleared' → fall through and maybe re-fire
    }

    const price = isOption ? await contractPrice(m.occ_symbol).catch(() => null) : await alpacaPaper.lastPrice(m.symbol);
    if (price == null || price <= 0) continue;
    const entry = Number(m.entry_price) || price;
    const peak = Math.max(Number(m.peak_price) || entry, price);
    const trough = Math.min(Number(m.trough_price) > 0 ? Number(m.trough_price) : entry, price);
    const fav = ((price - entry) / entry) * 100;
    const peakFav = ((peak - entry) / entry) * 100;
    await exec('UPDATE position_monitors SET last_price=:p, peak_price=:pk, trough_price=:tr WHERE id=:id', { p: price, pk: peak, tr: trough, id: m.id });

    let reason = exitReason(fav, peakFav, { tp: Number(m.tp_pct) || 0, sl: Number(m.sl_pct) || 0, trail: Number(m.trail_pct) || 0 }) || '';
    if (!reason && nearClose) {
      reason = await flattenReasonFor(m, env, { nearClose, longGap }) || '';
    }

    const held = await heldQtyForMonitor(m);
    const exact = await exactOpenQty(m);
    const zd = heldZeroDecision({ heldQty: held, exactOpenQty: exact, pendingExit: false });
    if (zd === 'orphan') {
      await orphanMonitor(m, 'held=0 — already flat (no zombie retry)');
      orphaned++;
      continue;
    }

    if (!reason) continue;
    if (Number(m.exit_attempts) >= MAX_EXIT_ATTEMPTS && /EXIT STUCK/i.test(String(m.reason || ''))) continue;

    try {
      const { executeDraft } = await import('../execute.js');
      const draft: OrderDraft = { env: (m.env || 'alpaca_paper') as TradingEnv, symbol: m.symbol, asset_class: m.asset_class, side: 'sell', qty: Number(m.qty), order_type: 'market', source: 'bot', bot_id: m.bot_id };
      if (isOption && m.occ_symbol) {
        const c = occToContract(m.occ_symbol);
        if (c) draft._contract = { occSymbol: m.occ_symbol, type: c.type, strike: c.strike, expiration: c.expiration, mid: price };
        draft.option_type = c?.type;
      }
      const res = await executeDraft(draft, { modeOverride: 'auto', rationale: `auto-exit: ${reason} (entry ${entry}, peak ${peak}, last ${price})` });
      const outcome = exitPlacementOutcome({
        status: res.status,
        fillPrice: res.fillPrice,
        filledQty: res.filledQty,
        orderQty: Number(m.qty),
      });
      if (outcome === 'filled') {
        await closeMonitorFilled(m, reason, Number(res.fillPrice) > 0 ? Number(res.fillPrice) : price, price, !!res.fillPrice);
        closed++;
      } else if (outcome === 'pending' && res.orderId > 0) {
        await markExiting(m, res.orderId, reason);
      } else if (await positionGoneExact(m, held, exact)) {
        await orphanMonitor(m, `position gone: ${String(res.reason).slice(0, 160)}`);
        orphaned++;
      } else {
        await exec("UPDATE position_monitors SET reason=:r WHERE id=:id", { r: `EXIT FAILED (${res.status}): ${res.reason}`.slice(0, 250), id: m.id });
        await audit('monitor.exit_failed', `${reason} ${m.symbol} exit ${res.status}: ${res.reason} — monitor kept OPEN to retry`, { id: m.id });
      }
    } catch (e: any) {
      await audit('monitor.error', `exit error for ${m.symbol} (monitor kept open): ${e?.message || String(e)}`, { id: m.id });
    }
  }
  return { checked: open.length, closed, attached, orphaned };
}

/** Re-attach a swing-law monitor on every unprotected long (NVDA/SPY after a botched close). */
export async function ensureMonitorsForOpenPositions(env: TradingEnv): Promise<number> {
  const pos = await q<any>(
    "SELECT * FROM positions WHERE env=:env AND ABS(qty) > 0 AND LOWER(asset_class) IN ('equity','etf','option')",
    { env },
  );
  let attached = 0;
  const pool = env === 'alpaca_paper' ? await loadBotMatchPool(env).catch(() => ({ orders: [], signals: [] })) : { orders: [] as MonitorOrderCandidate[], signals: [] as MonitorSignalCandidate[] };
  for (const p of pos) {
    const ac = String(p.asset_class || 'equity').toLowerCase();
    const occ = ac === 'option' ? String(p.occ_symbol || '') : '';
    if (ac === 'option' && !occ) continue;
    if (await openMonitorRow(env, p.symbol, occ)) continue;
    const matched = matchMonitorBot({ symbol: p.symbol, occ, orders: pool.orders, signals: pool.signals });
    const swing = swingExitBand();
    const entry = Number(p.avg_cost) || Number(p.avg_entry_price) || 0;
    if (!(entry > 0)) {
      await raiseAlert({
        level: 'critical', source: 'monitor',
        title: `Unprotected long: ${occ || p.symbol}`,
        body: 'Open position has no monitor and no entry price — cannot auto-attach. Flatten manually or re-sync.',
        symbol: p.symbol, dedupMin: 30,
      });
      continue;
    }
    const inflight = await findInflightExit(env, p.symbol, occ);
    try {
      await exec(
        `INSERT INTO position_monitors (symbol, occ_symbol, env, account_number, asset_class, qty, entry_price, peak_price, trough_price, last_price, tp_pct, sl_pct, trail_pct, bot_id, order_id, pending_exit_order_id, exit_attempts, reason)
         VALUES (:s,:occ,:env,:acct,:ac,:qty,:entry,:entry,:entry,:entry,:tp,:sl,:trail,:bid,:oid,:pid,:att,:reason)`,
        {
          s: p.symbol, occ, env, acct: p.account_number || 'agentic', ac,
          qty: Number(p.qty), entry, tp: swing.tp, sl: swing.sl, trail: swing.trail,
          bid: matched.bot_id, oid: matched.order_id,
          pid: inflight, att: inflight ? 1 : 0,
          reason: inflight ? exitingReason(inflight, 're-attached over working sell') : 're-attached unprotected long',
        },
      );
      await audit('monitor.reattach', `attached ${occ || p.symbol} @ ${entry} (pending exit ${inflight || 'none'})`, { env, bot_id: matched.bot_id, via: matched.via });
      attached++;
    } catch (e: any) {
      await audit('monitor.reattach_failed', `${occ || p.symbol}: ${e?.message || String(e)}`, { env });
    }
  }
  return attached;
}

async function settlePendingExit(m: any, orderId: number, env: TradingEnv): Promise<'closed' | 'orphaned' | 'pending' | 'cleared' | 'escalated'> {
  const [ord] = await q<any>('SELECT * FROM orders WHERE id=:id', { id: orderId });
  let status = String(ord?.status || '');
  let fill = Number(ord?.filled_price) || 0;
  let filledQty = Number(ord?.filled_qty) || 0;
  const brokerId = String(ord?.rh_order_id || '');
  if (brokerId) {
    const bro = await getBrokerOrder(brokerId, env);
    if (bro) {
      status = mapBrokerOrderStatus(bro.status);
      fill = Number(bro.filled_avg_price || bro.filled_price || fill) || fill;
      filledQty = Number(bro.filled_qty || filledQty) || filledQty;
      await exec('UPDATE orders SET status=:s, filled_price=:fp, filled_qty=:fq, raw=CAST(:raw AS JSON) WHERE id=:id', {
        s: status, fp: fill || null, fq: filledQty || null, raw: JSON.stringify(bro), id: orderId,
      });
    }
  }
  if (isTerminalFillStatus(status) || (fill > 0 && filledQty + 1e-9 >= Number(m.qty))) {
    const px = fill || Number(m.last_price) || Number(m.entry_price);
    await closeMonitorFilled(m, String(m.reason || 'exit').replace(/^EXIT PENDING \[exiting\][^\s]*\s*/, ''), px, px, fill > 0);
    return 'closed';
  }
  if (status === 'canceled' || status === 'rejected' || status === 'expired') {
    const held = await heldQtyForMonitor(m);
    const exact = await exactOpenQty(m);
    if (heldZeroDecision({ heldQty: held, exactOpenQty: exact, pendingExit: false }) === 'orphan') {
      await orphanMonitor(m, `exit ${status} and book is flat`);
      return 'orphaned';
    }
    await clearPending(m, `EXIT FAILED (${status}) — will retry`);
    return 'cleared';
  }

  const created = Date.parse(ord?.created_at || m.updated_at || '') || Date.now();
  const retry = shouldRetryStuckNew({
    ageMs: Date.now() - created,
    attempts: Number(m.exit_attempts) || 1,
    status,
  });
  if (retry === 'wait') {
    await exec("UPDATE position_monitors SET reason=:r WHERE id=:id", {
      r: exitingReason(orderId, `${status || 'working'} — waiting for fill`), id: m.id,
    });
    return 'pending';
  }
  if (retry === 'escalate') {
    await exec("UPDATE position_monitors SET reason=:r WHERE id=:id", {
      r: `EXIT STUCK [exiting] #${orderId} still ${status} after ${Number(m.exit_attempts) || 1} attempt(s)`.slice(0, 250),
      id: m.id,
    });
    await raiseAlert({
      level: 'critical', source: 'monitor',
      title: `EXIT STUCK: ${m.symbol} order #${orderId} still ${status}`,
      body: 'Broker qty is locked by a working sell. Cancel at Alpaca or wait for fill. Monitor kept OPEN — no more auto-retries.',
      symbol: m.symbol, dedupMin: 30,
    });
    return 'escalated';
  }
  // cancel_retry
  if (brokerId) await cancelBrokerOrder(brokerId, env);
  await exec("UPDATE orders SET status='canceled' WHERE id=:id AND status IN ('new','placed','accepted','pending_new')", { id: orderId });
  await clearPending(m, `EXIT FAILED (canceled stuck ${status}) — retry`);
  await audit('monitor.exit_cancel', `canceled stuck ${status} exit #${orderId} for ${m.symbol} — will retry`, { id: m.id });
  return 'cleared';
}

async function flattenReasonFor(m: any, env: TradingEnv, clock: { nearClose: boolean; longGap: boolean }): Promise<string | null> {
  let botHoldOvernight: boolean | null = null;
  let botHoldOverWeekend: boolean | null = null;
  let maxHoldBars = 0;
  let botName = '';
  let botKey = '';
  if (m.bot_id) {
    const [bot] = await q<{ name: string; risk: any; action: any }>('SELECT name, risk, action FROM bots WHERE id=:id AND env=:env', { id: m.bot_id, env });
    const r = bot?.risk ? (typeof bot.risk === 'string' ? safeParse(bot.risk) : bot.risk) : null;
    const a = bot?.action ? (typeof bot.action === 'string' ? safeParse(bot.action) : bot.action) : null;
    if (r && typeof r.hold_overnight === 'boolean') botHoldOvernight = r.hold_overnight;
    if (r && typeof r.hold_over_weekend === 'boolean') botHoldOverWeekend = r.hold_over_weekend;
    maxHoldBars = Number(a?._max_hold_bars) || 0;
    botName = String(bot?.name || '');
    botKey = String(a?.key || a?._key || '');
  }
  const etToday = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  const isOption = (m.asset_class || '').toLowerCase() === 'option';
  const c = isOption && m.occ_symbol ? occToContract(m.occ_symbol) : null;
  const occDte = c?.expiration ? calendarDte(c.expiration) : null;
  const leaps = isLeapsTrade({ expiration: c?.expiration, dte: occDte, name: botName, key: botKey });
  const maxHoldReason = (maxHoldBars > 0 && m.opened_at && businessDaysSince(m.opened_at, etToday) >= maxHoldBars)
    ? `flatten: max hold ${maxHoldBars} sessions reached`
    : null;
  return overnightFlattenReason({
    nearClose: clock.nearClose,
    longGap: clock.longGap,
    isLeaps: leaps,
    botHoldOvernight,
    botHoldOverWeekend,
    expiresToday: !!(c?.expiration && c.expiration <= etToday),
    maxHoldReason,
  });
}

async function openMonitorRow(env: string, symbol: string, occ: string): Promise<{ id: number; bot_id: number | null; order_id: number | null } | null> {
  const [row] = await q<{ id: number; bot_id: number | null; order_id: number | null }>(
    "SELECT id, bot_id, order_id FROM position_monitors WHERE status='open' AND env=:env AND symbol=:s AND IFNULL(occ_symbol,'')=:occ ORDER BY id DESC LIMIT 1",
    { env, s: symbol, occ: occ || '' },
  );
  return row || null;
}

type BotMatchPool = { orders: MonitorOrderCandidate[]; signals: MonitorSignalCandidate[] };

async function loadBotMatchPool(env: string): Promise<BotMatchPool> {
  const orders = await q<any>(BOT_MATCH_BUY_SQL, { env });
  const signals = await q<any>(BOT_MATCH_SIGNAL_SQL);
  return {
    orders: (orders || []).map((o) => ({
      id: o.id,
      bot_id: o.bot_id,
      symbol: o.symbol,
      side: o.side,
      status: o.status,
      bot_name: o.bot_name,
      occ: occFromOrderRaw(o.raw),
    })),
    signals: signals || [],
  };
}

/** Paper-only. Stamp recent NULL bot_id rows when one buy or one fired signal matches. */
export async function backfillNullMonitorBotIds(env: TradingEnv): Promise<{
  open: Map<number, number>;
  newestClosed: { id: number; bot_id: number; symbol: string; reason: string | null } | null;
}> {
  const open = new Map<number, number>();
  if (env !== 'alpaca_paper') return { open, newestClosed: null };
  const rows = await q<any>(
    `SELECT id, symbol, occ_symbol, status, reason FROM position_monitors
      WHERE bot_id IS NULL
        AND (env=:env OR env IS NULL)
        AND (
          status='open'
          OR (status='closed' AND closed_at >= DATE_SUB(NOW(), INTERVAL 14 DAY))
        )
      ORDER BY id DESC LIMIT 40`,
    { env },
  );
  if (!rows?.length) return { open, newestClosed: null };
  const pool = await loadBotMatchPool(env);
  let newestClosed: { id: number; bot_id: number; symbol: string; reason: string | null } | null = null;
  for (const row of rows) {
    const matched = matchMonitorBot({
      symbol: row.symbol,
      occ: row.occ_symbol,
      orders: pool.orders,
      signals: pool.signals,
    });
    if (!matched.bot_id || matched.via === 'ambiguous' || matched.via === 'none') continue;
    await exec(
      'UPDATE position_monitors SET bot_id=:bid, order_id=COALESCE(order_id, :oid) WHERE id=:id AND bot_id IS NULL',
      { bid: matched.bot_id, oid: matched.order_id, id: row.id },
    );
    if (row.status === 'open') open.set(Number(row.id), matched.bot_id);
    if (row.status === 'closed' && !newestClosed) {
      newestClosed = { id: Number(row.id), bot_id: matched.bot_id, symbol: String(row.symbol || ''), reason: row.reason ?? null };
    }
  }
  if (newestClosed) {
    try {
      const { tuneFromClosedMonitor } = await import('../muse/improve.js');
      await tuneFromClosedMonitor(newestClosed, { env, persistLastTune: true, allowDb: true });
    } catch { /* learning must not block stops */ }
  }
  return { open, newestClosed };
}

async function heldQtyForMonitor(m: any): Promise<number> {
  const env = m.env || 'alpaca_paper';
  const isOption = (m.asset_class || '').toLowerCase() === 'option';
  if (isOption) {
    const occ = m.occ_symbol || '';
    if (!occ) return 0;
    const [held] = await q<{ qty: number }>(
      "SELECT COALESCE(SUM(qty),0) qty FROM positions WHERE env=:env AND asset_class='option' AND occ_symbol=:occ",
      { env, occ },
    );
    return Number(held?.qty ?? 0);
  }
  const [held] = await q<{ qty: number }>(
    "SELECT COALESCE(SUM(qty),0) qty FROM positions WHERE symbol=:s AND env=:env AND asset_class<>'option'",
    { s: m.symbol, env },
  );
  return Number(held?.qty ?? 0);
}

async function exactOpenQty(m: any): Promise<number> {
  return heldQtyForMonitor(m);
}

async function positionGoneExact(m: any, held: number, exact: number): Promise<boolean> {
  return heldZeroDecision({ heldQty: held, exactOpenQty: exact, pendingExit: false }) === 'orphan'
    || (held === 0 && exact === 0);
}

async function findInflightExit(env: string, symbol: string, occ: string): Promise<number | null> {
  const rows = await q<any>(
    `SELECT id, raw FROM orders WHERE env=:env AND symbol=:s AND side='sell'
       AND status IN ('new','placed','accepted','pending_new','partially_filled')
     ORDER BY id DESC LIMIT 8`,
    { env, s: symbol },
  );
  for (const r of rows) {
    if (!occ) return Number(r.id);
    const raw = typeof r.raw === 'string' ? safeParse(r.raw) : r.raw;
    const rawOcc = raw?.draft?._contract?.occSymbol || raw?.place?.symbol || '';
    if (!rawOcc || rawOcc === occ) return Number(r.id);
  }
  return null;
}

async function markExiting(m: any, orderId: number, why: string): Promise<void> {
  const attempts = (Number(m.exit_attempts) || 0) + 1;
  await exec(
    "UPDATE position_monitors SET pending_exit_order_id=:oid, exit_attempts=:a, reason=:r WHERE id=:id",
    { oid: orderId, a: attempts, r: exitingReason(orderId, why), id: m.id },
  );
  await audit('monitor.exit_pending', `${why} ${m.symbol} order #${orderId} working — monitor kept OPEN until fill`, { id: m.id });
}

async function clearPending(m: any, reason: string): Promise<void> {
  await exec(
    "UPDATE position_monitors SET pending_exit_order_id=NULL, reason=:r WHERE id=:id",
    { r: reason.slice(0, 250), id: m.id },
  );
}

async function closeMonitorFilled(m: any, reason: string, exitFill: number, last: number, isFill: boolean): Promise<void> {
  await exec(
    "UPDATE position_monitors SET status='closed', reason=:r, exit_price=:xp, exit_is_fill=:isf, last_price=:p, pending_exit_order_id=NULL, closed_at=NOW() WHERE id=:id",
    { r: reason.slice(0, 250), xp: exitFill, isf: isFill ? 1 : 0, p: last, id: m.id },
  );
  await audit('monitor.close', `${reason} ${m.symbol} @ ${exitFill}${isFill ? ' (fill)' : ' (trigger≈fill)'} → filled`, { id: m.id, bot_id: m.bot_id ?? null });
  const env = (m.env || 'alpaca_paper') as TradingEnv;
  if (env === 'alpaca_paper') {
    try {
      const { tuneFromClosedMonitor } = await import('../muse/improve.js');
      await tuneFromClosedMonitor({
        id: m.id,
        bot_id: m.bot_id,
        symbol: m.symbol,
        reason,
        entry_price: m.entry_price,
        exit_price: exitFill,
      }, { env, persistLastTune: true, allowDb: true });
    } catch { /* Muse tune must not block the close */ }
  }
}

function safeParse(s: string): any { try { return JSON.parse(s); } catch { return null; } }

async function orphanMonitor(m: any, why: string): Promise<void> {
  const tag = /held=0|already flat|position gone/i.test(why) ? held0Reason(why) : `orphaned: ${why}`.slice(0, 250);
  await exec("UPDATE position_monitors SET status='orphaned', reason=:r, pending_exit_order_id=NULL, closed_at=NOW() WHERE id=:id", { r: tag, id: m.id });
  await audit('monitor.orphaned', `${m.occ_symbol || m.symbol} monitor orphaned — ${why}`, { id: m.id });
  await raiseAlert({ level: 'warn', source: 'monitor', title: `Monitor orphaned: ${m.occ_symbol || m.symbol}`, body: `No position left to protect (${why}). Monitor closed.`, symbol: m.symbol });
}

function businessDaysSince(openedAt: any, etToday: string): number {
  const start = new Date(openedAt);
  if (Number.isNaN(start.getTime())) return 0;
  const startDay = start.toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  let d = new Date(startDay + 'T12:00:00Z');
  const end = new Date(etToday + 'T12:00:00Z');
  let n = 0;
  while (d < end) {
    d = new Date(d.getTime() + 864e5);
    const wd = d.getUTCDay();
    if (wd !== 0 && wd !== 6) n++;
  }
  return n;
}
