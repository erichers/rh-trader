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

function normOcc(v: unknown): string {
  return String(v || '').replace(/\s+/g, '').trim();
}

function fromOrder(o: MonitorOrderCandidate): MonitorBotMatch {
  return { bot_id: positiveId(o.bot_id), order_id: positiveId(o.id), via: 'order' };
}

/**
 * Draft bot_id always wins (the fill that opened the position).
 * Otherwise the latest matching buy: exact OCC first (from raw.draft._contract.occSymbol),
 * then a buy that has no OCC stored (orders have no occ_symbol column).
 * A buy for a different contract is never used. No buy → one fired signal, else none.
 * AI opens stay null because they have no draft bot_id and no bot buy.
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
  const occ = normOcc(input.occ);
  const buys = (input.orders || [])
    .filter((o) => {
      if (String(o.side || 'buy').toLowerCase() !== 'buy') return false;
      if (String(o.symbol || '').toUpperCase() !== sym) return false;
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
