/**
 * Pure helpers for stamping bot_id on position monitors.
 * A reattached stop used to insert bot_id NULL, and a later bot fill then
 * bailed out because a monitor already existed. Muse cannot learn that close.
 *
 * Buy lookup uses filled / partially_filled rows only. A vetoed, canceled, or
 * rejected order must not stamp a bot — that is how Index QuickBot (SPY/QQQ)
 * landed on an open NVDA monitor. If no filled buy matches the OCC, bot_id
 * stays null rather than inventing one from a vetoed Index draft.
 */
import { INDEX_QUICKBOT_SYMBOLS, isIndexQuickbotName } from '../bots/indexUniverse.js';

export type MonitorBotVia = 'draft' | 'order' | 'signal' | 'ambiguous' | 'none';

export type MonitorBotMatch = {
  bot_id: number | null;
  order_id: number | null;
  via: MonitorBotVia;
};

export type MonitorOrderCandidate = {
  id?: number | null;
  bot_id?: number | null;
  symbol?: string | null;
  occ?: string | null;
  side?: string | null;
  /** Missing status is not a fill. Only filled / partially_filled attribute. */
  status?: string | null;
  bot_name?: string | null;
};

export type MonitorSignalCandidate = {
  bot_id?: number | null;
  symbol?: string | null;
  fired?: number | boolean | null;
  bot_name?: string | null;
};

const ATTRIBUTABLE_BUY_STATUSES = new Set(['filled', 'partially_filled']);

export function isAttributableBuyStatus(status: unknown): boolean {
  return ATTRIBUTABLE_BUY_STATUSES.has(String(status || '').trim().toLowerCase());
}

/** Index QuickBot may own SPY and QQQ only. Any other name is unrestricted. */
export function botMayOwnSymbol(botName: unknown, symbol: string): boolean {
  if (!isIndexQuickbotName(botName)) return true;
  const sym = String(symbol || '').toUpperCase();
  return (INDEX_QUICKBOT_SYMBOLS as readonly string[]).includes(sym);
}

export function positiveId(v: unknown): number | null {
  const n = typeof v === 'string' ? Number(v.trim()) : Number(v);
  if (!Number.isInteger(n) || n <= 0) return null;
  return n;
}

/** OCC from an order raw blob. Underlying tickers are not treated as contracts. */
export function occFromOrderRaw(raw: unknown): string {
  let o: any = raw;
  if (typeof raw === 'string') {
    try { o = JSON.parse(raw); } catch { return ''; }
  }
  if (!o || typeof o !== 'object') return '';
  const occ = o?.draft?._contract?.occSymbol
    || o?.draft?._contract?.occ_symbol
    || o?.place?.symbol
    || o?.contract?.occ_symbol
    || '';
  const s = String(occ || '').replace(/\s+/g, '').trim();
  return s.length >= 15 ? s : '';
}

function uniqueIds(values: unknown[]): number[] {
  const out: number[] = [];
  for (const v of values) {
    const id = positiveId(v);
    if (id && !out.includes(id)) out.push(id);
  }
  return out;
}

function normOcc(v: unknown): string {
  return String(v || '').replace(/\s+/g, '').trim();
}

function fromOrder(o: MonitorOrderCandidate): MonitorBotMatch {
  return { bot_id: positiveId(o.bot_id), order_id: positiveId(o.id), via: 'order' };
}

/**
 * A usable draft bot_id wins (the fill that opened the position).
 * A vetoed/canceled/rejected draft does not. Index QuickBot never owns NVDA.
 * Otherwise the latest filled or partially_filled buy: exact OCC first
 * (from raw.draft._contract.occSymbol), then a filled buy that has no OCC stored.
 * A buy for a different contract is never used. No filled buy → one fired
 * signal that may own the symbol, else none.
 * AI opens stay null because they have no draft bot_id and no bot buy.
 */
export function matchMonitorBot(input: {
  symbol: string;
  occ?: string | null;
  draftBotId?: number | null;
  draftOrderId?: number | null;
  draftStatus?: string | null;
  draftBotName?: string | null;
  orders?: MonitorOrderCandidate[];
  signals?: MonitorSignalCandidate[];
}): MonitorBotMatch {
  const sym = String(input.symbol || '').toUpperCase();
  const draft = positiveId(input.draftBotId);
  const draftStatus = input.draftStatus == null ? '' : String(input.draftStatus);
  const draftBlocked = draftStatus !== '' && !isAttributableBuyStatus(draftStatus);
  const draftOffUniverse = !botMayOwnSymbol(input.draftBotName, sym);
  if (draft && !draftBlocked && !draftOffUniverse) {
    return { bot_id: draft, order_id: positiveId(input.draftOrderId), via: 'draft' };
  }
  const occ = normOcc(input.occ);
  const buys = (input.orders || [])
    .filter((o) => {
      if (!isAttributableBuyStatus(o.status)) return false;
      if (String(o.side || 'buy').toLowerCase() !== 'buy') return false;
      if (String(o.symbol || '').toUpperCase() !== sym) return false;
      if (!botMayOwnSymbol(o.bot_name, sym)) return false;
      return !!positiveId(o.bot_id);
    })
    .sort((a, b) => (Number(b.id) || 0) - (Number(a.id) || 0));
  if (occ) {
    const exact = buys.find((o) => normOcc(o.occ) === occ);
    if (exact) return fromOrder(exact);
    const otherContract = buys.some((o) => {
      const oocc = normOcc(o.occ);
      return !!oocc && oocc !== occ;
    });
    const bare = buys.find((o) => !normOcc(o.occ));
    if (bare && !otherContract) return fromOrder(bare);
  } else {
    const hit = buys[0];
    if (hit) return fromOrder(hit);
  }
  const sigs = (input.signals || []).filter((s) => {
    if (s.fired === 0 || s.fired === false) return false;
    if (String(s.symbol || '').toUpperCase() !== sym) return false;
    if (!botMayOwnSymbol(s.bot_name, sym)) return false;
    return !!positiveId(s.bot_id);
  });
  const sigBots = uniqueIds(sigs.map((s) => s.bot_id));
  if (sigBots.length > 1) return { bot_id: null, order_id: null, via: 'ambiguous' };
  if (sigBots.length === 1) return { bot_id: sigBots[0], order_id: null, via: 'signal' };
  return { bot_id: null, order_id: null, via: 'none' };
}

export type MonitorOpenPlan = {
  action: 'skip' | 'stamp' | 'insert';
  bot_id: number | null;
  order_id: number | null;
};

/**
 * Opening plan. An existing monitor that already has bot_id is left alone.
 * An existing monitor with NULL bot_id adopts the fill's bot (the race that
 * dropped NVDA trailing-stop ids). Reattach still inserts when nothing is open,
 * even if no bot can be matched, so the long stays protected.
 */
export function planMonitorOpen(input: {
  draftBotId?: number | null;
  orderId?: number | null;
  matchedBotId?: number | null;
  matchedOrderId?: number | null;
  hasExisting: boolean;
  existingBotId?: number | null;
}): MonitorOpenPlan {
  const bot = positiveId(input.draftBotId) ?? positiveId(input.matchedBotId);
  const oid = positiveId(input.orderId) ?? positiveId(input.matchedOrderId);
  if (input.hasExisting) {
    const existing = positiveId(input.existingBotId);
    if (existing) return { action: 'skip', bot_id: existing, order_id: oid };
    if (bot) return { action: 'stamp', bot_id: bot, order_id: oid };
    return { action: 'skip', bot_id: null, order_id: oid };
  }
  return { action: 'insert', bot_id: bot, order_id: oid };
}
