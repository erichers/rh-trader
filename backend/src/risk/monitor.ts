import { q, exec, audit, getTradingEnv, getExitPolicy } from '../db.js';
import { raiseAlert } from '../alerts.js';
import { exitReason } from './exitpolicy.js';
import { alpacaPaper } from '../brokers/alpaca.js';
import { contractPrice, occToContract } from '../brokers/options.js';
import { getClock } from '../market/clock.js';
import type { OrderDraft } from './engine.js';
import { resolveBotRisk } from './sizing.js';
import type { TradingEnv } from '../config.js';

// Live position monitor: enforces per-bot take-profit / stop-loss / trailing-stop on
// bot-opened positions — equity/ETF (priced off the underlying) AND options (priced
// off the contract premium via its OCC symbol). Exits route through executeDraft.

export async function createMonitor(draft: OrderDraft, orderId: number, entryPrice: number, env?: TradingEnv): Promise<void> {
  // Bot positions OR AI-opened positions get monitored. (AI drafts have no bot_id.)
  if (!draft.bot_id && draft.source !== 'ai') return;
  const ac = (draft.asset_class || 'equity').toLowerCase();
  const occ = ac === 'option' ? (draft._contract?.occSymbol || '') : '';
  if (ac === 'option' && !occ) return; // can't monitor an option without its concrete contract
  if (ac !== 'equity' && ac !== 'etf' && ac !== 'option') return;
  if (!env) env = await getTradingEnv();
  const [bot] = draft.bot_id ? await q<{ risk: any }>('SELECT risk FROM bots WHERE id=:id AND env=:env', { id: draft.bot_id, env }) : [undefined as any];
  const r = bot?.risk ? (typeof bot.risk === 'string' ? safeParse(bot.risk) : bot.risk) : null;
  // A QuickBot play carries its own DTE-scaled exits (tighter for 1-day, wider for
  // 7-day) — those take precedence over the bot's flat take-profit/stop-loss.
  const p = draft._play;
  // EXITS: the bot's own take-profit / stop / trail, falling back to the global trade
  // defaults for any field it doesn't set (resolveBotRisk is the single resolver, shared
  // with the API and the UI). Bot positions only — an AI-opened position has no bot risk
  // and keeps its asset-class-aware defaults below.
  const eff = draft.bot_id ? await resolveBotRisk(r) : null;
  // A play's tp of 0 is DELIBERATE ("no cap, ride the trail" — the positive-skew rule),
  // so when the play states a take-profit it wins outright over bot/global values.
  let tp = p && p.tp != null ? Math.max(0, Number(p.tp) || 0) : (eff ? eff.take_profit_pct : Number(r?.take_profit_pct) || 0);
  let sl = Number(p?.sl) || (eff ? eff.stop_loss_pct : Number(r?.stop_loss_pct) || 0);
  let trail = Number(p?.trail) || (eff ? eff.trailing_stop_pct : Number(r?.trailing_stop_pct) || 0);
  // AI-opened positions have no per-bot risk config — give them sensible default stops so they
  // are never left unmanaged. Asymmetric "small loss, big win" profile: a fixed small stop, NO
  // take-profit cap (tp=0), and a trailing stop to let winners run (matches the QuickBot bands).
  if (draft.source === 'ai' && !tp && !sl && !trail) {
    if (ac === 'option') { tp = 0; sl = 35; trail = 40; } else { tp = 0; sl = 8; trail = 12; }
  }
  // Only the absence of ALL three means "unmanaged". A tp of 0 with a stop/trail is a valid
  // (no-cap) config, so guard on sl/trail too — don't bail just because there's no take-profit.
  if (!tp && !sl && !trail) return; // nothing to manage
  // Entry = the fill basis: option premium for options, share price for shares.
  let entry = entryPrice;
  if (!(entry > 0)) entry = (ac === 'option' ? (await contractPrice(occ)) : (await alpacaPaper.lastPrice(draft.symbol, { allowStale: true }))) || 0;
  if (!(entry > 0)) {
    // A filled bot/AI buy with NO monitor is an unprotected position — never fail silently.
    // (Gate review 2026-08-24: the fresh-price guard could suppress monitor creation here.)
    await audit('monitor.create_failed', `no entry price for ${occ || draft.symbol} — position has NO stop monitor`, { order_id: orderId });
    await raiseAlert({ level: 'critical', source: 'monitor', title: `No stop monitor: ${occ || draft.symbol}`, body: `Order #${orderId} filled but no entry price could be resolved — the position is UNPROTECTED. Add a manual stop or re-sync.`, symbol: draft.symbol });
    return;
  }
  await exec(
    `INSERT INTO position_monitors (symbol, occ_symbol, env, account_number, asset_class, qty, entry_price, peak_price, trough_price, last_price, tp_pct, sl_pct, trail_pct, bot_id, order_id)
     VALUES (:s,:occ,:env,:acct,:ac,:qty,:entry,:entry,:entry,:entry,:tp,:sl,:trail,:bid,:oid)`,
    { s: draft.symbol, occ, env, acct: 'agentic', ac, qty: draft.qty, entry, tp, sl, trail, bid: draft.bot_id ?? null, oid: orderId },
  );
  await audit('monitor.open', `watching ${occ || draft.symbol} from ${entry} on ${env} (tp ${tp}/sl ${sl}/trail ${trail})`, { bot_id: draft.bot_id ?? null, source: draft.source });
}

/** Evaluate open monitors FOR THE ACTIVE ENV ONLY; close on TP/SL/trailing.
 *  A monitor opened under paper must never fire a sell against a live account
 *  (or vice-versa) — so we only manage monitors whose env matches the active env. */
export async function checkMonitors(opts?: { reconcileOnly?: boolean }): Promise<{ checked: number; closed: number }> {
  const env = await getTradingEnv();
  // NULL env = legacy monitor; treat as paper (the only env exits ran under before).
  const open = await q<any>("SELECT * FROM position_monitors WHERE status='open' AND (env=:env OR (env IS NULL AND :env='alpaca_paper'))", { env });

  // Overnight/weekend flatten: figure out how close we are to the session close and whether
  // a long (weekend/holiday) gap follows it — so positions can be flattened before the close.
  const policy = await getExitPolicy();
  let minsToClose = Infinity, longGap = false;
  try {
    const clk = await getClock();
    if (clk.is_open && clk.next_close) {
      minsToClose = (Date.parse(clk.next_close) - Date.now()) / 60000;
      if (clk.next_open) longGap = (Date.parse(clk.next_open) - Date.parse(clk.next_close)) > 1.6 * 864e5; // >~1.5d ⇒ weekend/holiday ahead
    }
  } catch { /* clock unavailable → skip time-based flatten this cycle */ }
  const nearClose = minsToClose > 0 && minsToClose <= policy.closeBufferMin;

  let closed = 0;
  for (const m of open) {
    const isOption = (m.asset_class || '').toLowerCase() === 'option';
    // Reconciliation (2026-08-24 audit): a monitor on an EXPIRED contract protects nothing —
    // the position is gone. Orphan it once instead of sticking open forever (pricing an
    // expired OCC returns null, so these rows silently never reached the exit path).
    if (isOption && m.occ_symbol) {
      const c = occToContract(m.occ_symbol);
      const etToday = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
      if (c?.expiration && c.expiration < etToday) {
        await orphanMonitor(m, `contract expired ${c.expiration}`);
        continue;
      }
    }
    // Reconcile-only pass (market closed): expired-contract cleanup above still runs so
    // dead monitors can't feed false "unprotected position" alerts off-hours; pricing
    // and exits wait for the session. (2026-08-24 audit)
    if (opts?.reconcileOnly) continue;
    // Options are priced off the contract premium (OCC); shares off the underlying.
    const price = isOption ? await contractPrice(m.occ_symbol).catch(() => null) : await alpacaPaper.lastPrice(m.symbol);
    if (price == null || price <= 0) continue;
    const entry = Number(m.entry_price) || price;
    const peak = Math.max(Number(m.peak_price) || entry, price);
    // Track the trough (max adverse excursion) too — the raw material for data-driven stop
    // tuning ("how far do winners dip before they run?"). NULL on legacy rows → seed with entry.
    const trough = Math.min(Number(m.trough_price) > 0 ? Number(m.trough_price) : entry, price);
    // We hold a LONG option (or long shares): profit when the premium / price RISES,
    // so the same TP/SL/trail logic on (price-entry) works for calls and puts alike.
    const fav = ((price - entry) / entry) * 100;
    const peakFav = ((peak - entry) / entry) * 100;
    await exec('UPDATE position_monitors SET last_price=:p, peak_price=:pk, trough_price=:tr WHERE id=:id', { p: price, pk: peak, tr: trough, id: m.id });

    // Exit ladder lives in risk/exitpolicy.ts — SHARED with the backtest simulator (no drift).
    // Adds the breakeven lock (a +30% trade can't close negative) and the ratcheting trail.
    let reason = exitReason(fav, peakFav, { tp: Number(m.tp_pct) || 0, sl: Number(m.sl_pct) || 0, trail: Number(m.trail_pct) || 0 }) || '';
    // Time-based flatten (no-overnight / no-weekend), with per-bot override of the global policy.
    if (!reason && nearClose) {
      let holdOvernight = policy.holdOvernight, holdOverWeekend = policy.holdOverWeekend;
      let maxHoldBars = 0;
      if (m.bot_id) {
        const [bot] = await q<{ risk: any; action: any }>('SELECT risk, action FROM bots WHERE id=:id AND env=:env', { id: m.bot_id, env });
        const r = bot?.risk ? (typeof bot.risk === 'string' ? safeParse(bot.risk) : bot.risk) : null;
        const a = bot?.action ? (typeof bot.action === 'string' ? safeParse(bot.action) : bot.action) : null;
        if (r && typeof r.hold_overnight === 'boolean') holdOvernight = r.hold_overnight;
        if (r && typeof r.hold_over_weekend === 'boolean') holdOverWeekend = r.hold_over_weekend;
        maxHoldBars = Number(a?._max_hold_bars) || 0;
      }
      // Hard limits that OVERRIDE any hold policy (final gate 2026-08-25): a long option is
      // always sold on its expiration day (never carried into expiry/assignment), and an
      // idea bot's backtested max hold is enforced live (the sim exited at that bar).
      const etToday = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
      const c = isOption && m.occ_symbol ? occToContract(m.occ_symbol) : null;
      if (c?.expiration && c.expiration <= etToday) reason = 'flatten: contract expires today';
      else if (maxHoldBars > 0 && m.opened_at && businessDaysSince(m.opened_at, etToday) >= maxHoldBars) reason = `flatten: max hold ${maxHoldBars} sessions reached`;
      else if (!holdOvernight) reason = 'flatten: no overnight';
      else if (longGap && !holdOverWeekend) reason = 'flatten: no weekend hold';
    }
    if (!reason) continue;

    try {
      const { executeDraft } = await import('../execute.js');
      const draft: OrderDraft = { env: (m.env || 'alpaca_paper') as TradingEnv, symbol: m.symbol, asset_class: m.asset_class, side: 'sell', qty: Number(m.qty), order_type: 'market', source: 'bot', bot_id: m.bot_id };
      if (isOption && m.occ_symbol) {
        // Reconstruct the exact contract so the sell is matched to the held position
        // and placed on that OCC contract (never re-resolved to a different one).
        const c = occToContract(m.occ_symbol);
        if (c) draft._contract = { occSymbol: m.occ_symbol, type: c.type, strike: c.strike, expiration: c.expiration, mid: price };
        draft.option_type = c?.type;
      }
      const res = await executeDraft(draft, { modeOverride: 'auto', rationale: `auto-exit: ${reason} (entry ${entry}, peak ${peak}, last ${price})` });
      // ONLY mark closed if the exit ACTUALLY went through (placed/filled). If the exit was
      // vetoed/rejected/staged, the position is STILL OPEN — keep the monitor open so we retry
      // next cycle instead of silently abandoning a failed stop-loss (which would leave a live
      // position unprotected). Record the failure for visibility.
      const exited = res.status === 'placed' || res.status === 'filled';
      if (exited) {
        // Record the ACTUAL exit fill when the broker reported one; otherwise fall back to the
        // trigger price (the last monitored premium/price ≈ fill). exit_is_fill in the journal
        // distinguishes the two so realized P/L is never silently overstated.
        const exitFill = Number(res.fillPrice) > 0 ? Number(res.fillPrice) : price;
        await exec("UPDATE position_monitors SET status='closed', reason=:r, exit_price=:xp, exit_is_fill=:isf, last_price=:p, closed_at=NOW() WHERE id=:id", { r: reason, xp: exitFill, isf: Number(res.fillPrice) > 0 ? 1 : 0, p: price, id: m.id });
        await audit('monitor.close', `${reason} ${m.symbol} @ ${exitFill}${Number(res.fillPrice) > 0 ? ' (fill)' : ' (trigger≈fill)'} → ${res.status}`, { id: m.id });
        closed++;
      } else if (await positionGone(m, res)) {
        // Structured held=0 check (gate review 2026-08-24: prose-matching the veto text
        // orphaned partially-filled positions, sell 2 > held 1). Orphan only on the SECOND
        // consecutive held=0 veto (our own [held0] marker) so a mid-sync positions gap
        // (the snapshot is delete-then-reinsert) can't orphan a real stop.
        if (/\[held0\]/.test(String(m.reason || ''))) {
          await orphanMonitor(m, `position gone: ${String(res.reason).slice(0, 160)}`);
        } else {
          await exec("UPDATE position_monitors SET reason=:r WHERE id=:id", { r: `EXIT FAILED [held0] (${res.status}): ${res.reason}`.slice(0, 250), id: m.id });
          await audit('monitor.exit_failed', `${reason} ${m.symbol} exit vetoed with held=0 and no position row — will orphan if it persists next cycle`, { id: m.id });
        }
      } else {
        await exec("UPDATE position_monitors SET reason=:r WHERE id=:id", { r: `EXIT FAILED (${res.status}): ${res.reason}`.slice(0, 250), id: m.id });
        await audit('monitor.exit_failed', `${reason} ${m.symbol} exit ${res.status}: ${res.reason} — monitor kept OPEN to retry`, { id: m.id });
      }
    } catch (e: any) {
      // Exception during exit — keep the monitor OPEN (do not abandon the stop) and retry.
      await audit('monitor.error', `exit error for ${m.symbol} (monitor kept open): ${e?.message || String(e)}`, { id: m.id });
    }
  }
  return { checked: open.length, closed };
}

function safeParse(s: string): any { try { return JSON.parse(s); } catch { return null; } }

/** Close a monitor that no longer protects anything (position gone / contract expired).
 *  Distinct status keeps these out of the journal's closed-trade stats. */
async function orphanMonitor(m: any, why: string): Promise<void> {
  await exec("UPDATE position_monitors SET status='orphaned', reason=:r, closed_at=NOW() WHERE id=:id", { r: `orphaned: ${why}`.slice(0, 250), id: m.id });
  await audit('monitor.orphaned', `${m.occ_symbol || m.symbol} monitor orphaned — ${why}`, { id: m.id });
  await raiseAlert({ level: 'warn', source: 'monitor', title: `Monitor orphaned: ${m.occ_symbol || m.symbol}`, body: `No position left to protect (${why}). Monitor closed.`, symbol: m.symbol });
}

/** TRUE only when the risk engine MEASURED held quantity 0 AND the positions snapshot
 *  holds nothing on this symbol/class in this env — really gone, not partially filled
 *  (held>0 retries) and not merely unmatchable on a malformed OCC (any surviving option
 *  row on the underlying blocks orphaning). (2026-08-24 gate review) */
async function positionGone(m: any, res: any): Promise<boolean> {
  const c = res?.risk?.computed || {};
  const held = Number(c.held_contracts ?? c.held_qty ?? NaN);
  if (held !== 0) return false;
  const isOption = (m.asset_class || '').toLowerCase() === 'option';
  const [row] = await q<{ n: number }>(
    isOption
      ? "SELECT COUNT(*) n FROM positions WHERE env=:env AND asset_class='option' AND symbol=:s AND ABS(qty) > 0"
      : "SELECT COUNT(*) n FROM positions WHERE env=:env AND asset_class<>'option' AND symbol=:s AND ABS(qty) > 0",
    { env: m.env || 'alpaca_paper', s: m.symbol },
  );
  return !Number(row?.n);
}

/** Trading sessions elapsed from the open date (exclusive) to today (inclusive), weekdays only.
 *  Holidays are not subtracted, so this can only flatten a session EARLY, never late. */
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
