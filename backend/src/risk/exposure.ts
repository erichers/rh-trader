/**
 * Same-symbol exposure across concurrent bot tickets.
 *
 * Per-ticket caps were not enough: Donchian + Momentum Day + Opening Range each
 * stayed under max_position_usd but stacked ~$13.7k of META. Concentration and
 * max position must apply to the combined book, not one ticket.
 */

export const IN_FLIGHT_BUY_STATUSES = ['placed', 'filled', 'staged'] as const;

const CONTRACT_MULT = 100;

export type ExposureOrder = {
  qty?: any;
  filled_price?: any;
  limit_price?: any;
  asset_class?: any;
  status?: any;
  raw?: any;
  created_at?: any;
};

export function parseEstPrice(raw: any): number {
  if (raw == null) return 0;
  let obj = raw;
  if (typeof raw === 'string') {
    try { obj = JSON.parse(raw); } catch { return 0; }
  }
  if (typeof obj !== 'object') return 0;
  const candidates = [
    obj?.draft?.est_price,
    obj?.est_price,
    obj?.decision?.risk?.computed?.notional_usd,
  ];
  for (const c of candidates) {
    const n = Number(c);
    if (Number.isFinite(n) && n > 0) {
      // notional_usd is already dollars; only use it when no per-share price exists
      if (c === obj?.decision?.risk?.computed?.notional_usd) continue;
      return n;
    }
  }
  return 0;
}

export function orderBuyNotional(row: ExposureOrder): number {
  const qty = Number(row?.qty);
  if (!Number.isFinite(qty) || qty <= 0) return 0;
  const px = Number(row?.filled_price) || Number(row?.limit_price) || parseEstPrice(row?.raw);
  if (!(px > 0)) return 0;
  const ac = String(row?.asset_class || 'equity').toLowerCase();
  const mult = ac === 'option' ? CONTRACT_MULT : 1;
  return px * qty * mult;
}

export function splitInflightBuys(rows: ExposureOrder[], etDay: string): { pendingUsd: number; todayFilledUsd: number } {
  let pendingUsd = 0;
  let todayFilledUsd = 0;
  for (const row of rows) {
    const status = String(row?.status || '').toLowerCase();
    if (status === 'vetoed' || status === 'draft' || status === 'canceled' || status === 'rejected' || status === 'observe_only') continue;
    const usd = orderBuyNotional(row);
    if (!(usd > 0)) continue;
    if (status === 'filled') {
      const day = etDayOf(row?.created_at);
      if (!etDay || !day || day === etDay) todayFilledUsd += usd;
      continue;
    }
    if (status === 'placed' || status === 'staged') pendingUsd += usd;
  }
  return { pendingUsd, todayFilledUsd };
}

function etDayOf(ts: any): string {
  if (!ts) return '';
  const d = ts instanceof Date ? ts : new Date(ts);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
}

export function todayEt(): string {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
}

/** Held book for one symbol: prefer the live snapshot, fall back to today's fills if stale. */
export function openSymbolExposureUsd(opts: {
  positionMv: number;
  todayFilledUsd: number;
  pendingUsd: number;
  reservedUsd: number;
}): number {
  const held = Math.max(0, Number(opts.positionMv) || 0);
  const filled = Math.max(0, Number(opts.todayFilledUsd) || 0);
  const pending = Math.max(0, Number(opts.pendingUsd) || 0);
  const reserved = Math.max(0, Number(opts.reservedUsd) || 0);
  return Math.max(held, filled) + pending + reserved;
}

export type SymbolCapResult = {
  ticketOk: boolean;
  positionOk: boolean;
  concentrationOk: boolean;
  stackedUsd: number;
  concentrationPct: number | null;
  ticketDetail: string;
  positionDetail: string;
  concentrationDetail: string;
};

export function evaluateSymbolCaps(opts: {
  side: 'buy' | 'sell' | string;
  ticketNotional: number;
  openUsd: number;
  equity: number;
  maxPositionUsd: number;
  maxConcentrationPct: number;
}): SymbolCapResult {
  const ticket = Math.max(0, Number(opts.ticketNotional) || 0);
  const open = Math.max(0, Number(opts.openUsd) || 0);
  const stacked = open + ticket;
  const maxPos = Number(opts.maxPositionUsd) || 0;
  const maxConc = Number(opts.maxConcentrationPct) || 0;
  const equity = Number(opts.equity) || 0;

  if (String(opts.side).toLowerCase() !== 'buy') {
    return {
      ticketOk: true,
      positionOk: true,
      concentrationOk: true,
      stackedUsd: open,
      concentrationPct: equity > 0 ? Math.round((open / equity) * 10000) / 100 : null,
      ticketDetail: 'sell/exit — not sized as new exposure',
      positionDetail: 'sell/exit — not capped as new exposure',
      concentrationDetail: 'sell/exit — not capped as new exposure',
    };
  }

  const ticketOk = !(ticket > 0) || !(maxPos > 0) || ticket <= maxPos;
  const positionOk = !(stacked > 0) || !(maxPos > 0) || stacked <= maxPos;
  const concentrationPct = equity > 0 && stacked > 0 ? Math.round((stacked / equity) * 10000) / 100 : null;
  const concentrationOk = concentrationPct == null || !(maxConc > 0) || concentrationPct <= maxConc;

  return {
    ticketOk,
    positionOk,
    concentrationOk,
    stackedUsd: Math.round(stacked * 100) / 100,
    concentrationPct,
    ticketDetail: ticketOk
      ? `${round2(ticket)} <= ${maxPos} (ticket)`
      : `${round2(ticket)} > ${maxPos} (ticket)`,
    positionDetail: positionOk
      ? `${round2(stacked)} <= ${maxPos} (symbol book across bots)`
      : `${round2(stacked)} > ${maxPos} (symbol book across bots)`,
    concentrationDetail: concentrationPct == null
      ? (equity > 0 ? 'no new notional — skipped' : 'no equity snapshot — skipped')
      : `${concentrationPct}% vs cap ${maxConc}% (symbol book across bots)`,
  };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

// ── In-process reservation (closes the same-cycle multi-bot race) ───────────
const reservedByKey = new Map<string, number>();

export function exposureKey(env: string, symbol: string): string {
  return `${String(env || '')}:${String(symbol || '').toUpperCase()}`;
}

export function reservedBuyNotional(env: string, symbol: string): number {
  return reservedByKey.get(exposureKey(env, symbol)) || 0;
}

export function reserveBuyNotional(env: string, symbol: string, usd: number): void {
  const add = Number(usd);
  if (!(add > 0)) return;
  const k = exposureKey(env, symbol);
  reservedByKey.set(k, (reservedByKey.get(k) || 0) + add);
}

export function releaseBuyNotional(env: string, symbol: string, usd: number): void {
  const sub = Number(usd);
  if (!(sub > 0)) return;
  const k = exposureKey(env, symbol);
  const next = (reservedByKey.get(k) || 0) - sub;
  if (next <= 1e-9) reservedByKey.delete(k);
  else reservedByKey.set(k, next);
}

/** Test-only: clear reservations between cases. */
export function _resetReservations(): void {
  reservedByKey.clear();
}
