/**
 * Pure helpers for stamping bot_id on position monitors.
 * A reattached stop used to insert bot_id NULL, and a later bot fill then
 * bailed out because a monitor already existed. Muse cannot learn that close.
 */

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
};

export type MonitorSignalCandidate = {
  bot_id?: number | null;
  symbol?: string | null;
  fired?: number | boolean | null;
};

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

/**
 * Safe match. Draft bot_id always wins (the fill that opened the position).
 * Otherwise one distinct bot on matching buys, else one distinct fired signal.
 * Two different bots → ambiguous, leave NULL (do not guess).
 */
export function matchMonitorBot(input: {
  symbol: string;
  occ?: string | null;
  draftBotId?: number | null;
  draftOrderId?: number | null;
  orders?: MonitorOrderCandidate[];
  signals?: MonitorSignalCandidate[];
}): MonitorBotMatch {
  const draft = positiveId(input.draftBotId);
  if (draft) {
    return { bot_id: draft, order_id: positiveId(input.draftOrderId), via: 'draft' };
  }
  const sym = String(input.symbol || '').toUpperCase();
  const occ = String(input.occ || '').replace(/\s+/g, '').trim();
  const orders = (input.orders || []).filter((o) => {
    if (String(o.side || 'buy').toLowerCase() !== 'buy') return false;
    if (String(o.symbol || '').toUpperCase() !== sym) return false;
    if (!positiveId(o.bot_id)) return false;
    if (occ) {
      const oocc = String(o.occ || '').replace(/\s+/g, '').trim();
      if (oocc && oocc !== occ) return false;
    }
    return true;
  });
  const orderBots = uniqueIds(orders.map((o) => o.bot_id));
  if (orderBots.length > 1) return { bot_id: null, order_id: null, via: 'ambiguous' };
  if (orderBots.length === 1) {
    const hit = orders.find((o) => positiveId(o.bot_id) === orderBots[0]);
    return { bot_id: orderBots[0], order_id: positiveId(hit?.id), via: 'order' };
  }
  const sigs = (input.signals || []).filter((s) => {
    if (s.fired === 0 || s.fired === false) return false;
    if (String(s.symbol || '').toUpperCase() !== sym) return false;
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
