import { config } from '../config.js';
import { alpacaData } from './alpaca.js';
import { pickListedExpiration, type PickExpirationOpts } from '../risk/dte.js';
import {
  lookupByOcc,
  mergeQuoteFields,
  optionPremium,
  pickNearestContract,
  quoteSides,
  strikeTargetPrice,
  twoSidedMid,
} from '../risk/optionPrice.js';

// Alpaca options data: real contracts + live quotes (indicative feed).
// Greeks/IV are not in the free indicative feed; we surface price/bid/ask/OI.

function tHeaders() {
  return { 'APCA-API-KEY-ID': config.alpaca.apiKey, 'APCA-API-SECRET-KEY': config.alpaca.secretKey };
}
const TRADE = () => config.alpaca.paperBaseUrl; // contracts live on the trading API
const DATA = () => config.alpaca.dataUrl.replace('/v2', '/v1beta1');

async function get(url: string): Promise<any> {
  const r = await fetch(url, { headers: tHeaders() });
  const txt = await r.text();
  if (!r.ok) throw new Error(`alpaca ${r.status}: ${txt.slice(0, 200)}`);
  return JSON.parse(txt);
}

export type OptContract = {
  symbol: string; type: 'call' | 'put'; strike: number; expiration: string;
  open_interest: number | null; close_price: number | null;
  bid?: number | null; ask?: number | null; mid?: number | null;
  last?: number | null; volume?: number | null;
  // Greeks + implied vol (Alpaca options snapshots — available on the indicative feed).
  iv?: number | null; delta?: number | null; gamma?: number | null; theta?: number | null; vega?: number | null; rho?: number | null;
};

/** Full option snapshots (quote + last trade + greeks + IV) for an underlying/expiration. */
export async function snapshots(
  underlying: string, expiration?: string,
): Promise<Record<string, any>> {
  const out: Record<string, any> = {};
  let token = '';
  for (let i = 0; i < 8; i++) {
    const params = new URLSearchParams({ feed: 'indicative', limit: '1000' });
    if (expiration) params.set('expiration_date', expiration);
    if (token) params.set('page_token', token);
    const u = `${DATA()}/options/snapshots/${encodeURIComponent(underlying.toUpperCase())}?${params.toString()}`;
    let res: any;
    try { res = await get(u); } catch { break; }
    Object.assign(out, res.snapshots || {});
    token = res.next_page_token || '';
    if (!token) break;
  }
  return out;
}

/** List option contracts for an underlying (optionally a single expiration / type). */
export async function listContracts(
  underlying: string, opts: { expiration?: string; type?: 'call' | 'put'; limit?: number } = {},
): Promise<OptContract[]> {
  const params = new URLSearchParams({ underlying_symbols: underlying.toUpperCase(), limit: String(opts.limit ?? 1000) });
  if (opts.expiration) params.set('expiration_date', opts.expiration);
  if (opts.type) params.set('type', opts.type);
  const out: OptContract[] = [];
  let token = '';
  for (let i = 0; i < 6; i++) {
    const u = `${TRADE()}/options/contracts?${params.toString()}${token ? `&page_token=${token}` : ''}`;
    const res = await get(u);
    for (const c of res.option_contracts || []) {
      out.push({
        symbol: c.symbol, type: c.type, strike: Number(c.strike_price), expiration: c.expiration_date,
        open_interest: c.open_interest != null ? Number(c.open_interest) : null,
        close_price: c.close_price != null ? Number(c.close_price) : null,
      });
    }
    token = res.next_page_token || '';
    if (!token || out.length >= (opts.limit ?? 1000)) break;
  }
  return out;
}

/** Distinct upcoming expirations for an underlying (sorted). */
export async function expirations(underlying: string): Promise<string[]> {
  const cs = await listContracts(underlying, { limit: 1000 });
  return [...new Set(cs.map((c) => c.expiration))].sort();
}

export type LatestQuote = {
  bid: number | null;
  ask: number | null;
  mid: number | null;
  last: number | null;
  close: number | null;
};

/** Latest quotes for a batch of OCC symbols. Missing sides stay null (not 0). */
export async function latestQuotes(symbols: string[]): Promise<Record<string, LatestQuote>> {
  const out: Record<string, LatestQuote> = {};
  for (let i = 0; i < symbols.length; i += 100) {
    const batch = symbols.slice(i, i + 100);
    const u = `${DATA()}/options/quotes/latest?symbols=${encodeURIComponent(batch.join(','))}&feed=indicative`;
    try {
      const res = await get(u);
      for (const [sym, q] of Object.entries<any>(res.quotes || {})) {
        const sides = quoteSides(q);
        out[sym] = {
          bid: sides.bid,
          ask: sides.ask,
          mid: twoSidedMid(sides.bid, sides.ask),
          last: sides.last,
          close: sides.close,
        };
      }
    } catch { /* skip batch */ }
  }
  return out;
}

/** Full chain for one expiration: calls + puts with live bid/ask/mid + greeks + IV. */
export async function getChain(underlying: string, expiration: string): Promise<{ calls: OptContract[]; puts: OptContract[] }> {
  const [contracts, snaps] = await Promise.all([
    listContracts(underlying, { expiration, limit: 1000 }),
    snapshots(underlying, expiration).catch(() => ({} as Record<string, any>)),
  ]);
  // Snapshot-exists ≠ quoted. Indicative snapshots often have greeks/IV and an
  // empty latestQuote. Fall through to /quotes/latest unless we already have a
  // mark (bid/ask/last). OCC keys are looked up with and without space-padding.
  const needQuote = contracts.filter((c) => {
    const s = lookupByOcc(snaps, c.symbol);
    if (!s) return true;
    const sides = quoteSides(s);
    return sides.bid == null && sides.ask == null && sides.last == null;
  }).map((c) => c.symbol);
  const quotes = needQuote.length ? await latestQuotes(needQuote).catch(() => ({})) : {};
  for (const c of contracts) {
    const s = lookupByOcc(snaps, c.symbol);
    const qq = lookupByOcc(quotes as Record<string, any>, c.symbol);
    const marks = mergeQuoteFields(s ? quoteSides(s) : null, qq);
    c.bid = marks.bid ?? null;
    c.ask = marks.ask ?? null;
    c.mid = marks.mid ?? twoSidedMid(c.bid, c.ask);
    c.last = marks.last ?? null;
    if (marks.close != null) c.close_price = marks.close;
    if (s) {
      c.iv = s.impliedVolatility != null ? Number(s.impliedVolatility) : null;
      const g = s.greeks || {};
      c.delta = num(g.delta); c.gamma = num(g.gamma); c.theta = num(g.theta); c.vega = num(g.vega); c.rho = num(g.rho);
    }
  }
  const calls = contracts.filter((c) => c.type === 'call').sort((a, b) => a.strike - b.strike);
  const puts = contracts.filter((c) => c.type === 'put').sort((a, b) => a.strike - b.strike);
  return { calls, puts };
}

function num(v: any): number | null {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Real current price (mid → ask → last → close) for a single contract. */
export async function contractPrice(symbol: string): Promise<number | null> {
  const q = await latestQuotes([symbol]);
  const hit = lookupByOcc(q, symbol) || q[symbol];
  if (!hit) return null;
  return optionPremium({ mid: hit.mid, bid: hit.bid, ask: hit.ask, last: hit.last, close: hit.close }, 'buy').price;
}

export type ResolvedContract = {
  occSymbol: string; type: 'call' | 'put'; strike: number; expiration: string;
  bid: number | null; ask: number | null; mid: number | null; spot: number | null;
  last?: number | null; close?: number | null;
  readable: string; instrumentId?: string;
};

/** Build an OCC option symbol from parts (e.g. QQQ + 2026-07-03 + call + 595 → QQQ260703C00595000). */
export function buildOcc(underlying: string, expISO: string, type: 'call' | 'put', strike: number): string {
  const [y, m, d] = expISO.split('-');
  const cp = type === 'call' ? 'C' : 'P';
  const strk = String(Math.round(strike * 1000)).padStart(8, '0');
  return `${underlying.toUpperCase()}${y.slice(2)}${m}${d}${cp}${strk}`;
}

/** Parse an OCC option symbol back into its parts (e.g. NVDA260116C00800000). */
export function occToContract(occ: string): { underlying: string; type: 'call' | 'put'; strike: number; expiration: string } | null {
  const m = /^([A-Z]+)(\d{2})(\d{2})(\d{2})([CP])(\d{8})$/.exec(occ.toUpperCase());
  if (!m) return null;
  const [, underlying, yy, mm, dd, cp, strk] = m;
  return { underlying, type: cp === 'C' ? 'call' : 'put', strike: Number(strk) / 1000, expiration: `20${yy}-${mm}-${dd}` };
}

export type ResolveContractOpts = Pick<PickExpirationOpts, 'targetDte' | 'allowShortDte' | 'now' | 'name' | 'key'> & {
  /** Ignore last and close when picking a strike. */
  strictPrice?: boolean;
};

const targetPrice = strikeTargetPrice;

const readableExp = (iso: string) => new Date(iso + 'T00:00:00').toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });

/**
 * Resolve a target (type + strikeTarget + expiration horizon) to a CONCRETE, real
 * tradable contract from the live chain. Returns null if nothing resolves — callers
 * MUST fail closed rather than guess. Shared by Alpaca + Robinhood placement.
 */
export async function resolveContract(
  underlying: string, type: 'call' | 'put', strikeTarget: string, expirationPref: string,
  opts: ResolveContractOpts = {},
): Promise<ResolvedContract | null> {
  underlying = underlying.toUpperCase();
  const exps = await expirations(underlying).catch(() => [] as string[]);
  if (!exps.length) return null;
  const exp = pickListedExpiration(exps, {
    pref: expirationPref || 'weekly',
    targetDte: opts.targetDte,
    allowShortDte: opts.allowShortDte === true,
    now: opts.now,
    name: opts.name,
    key: opts.key,
  });
  if (!exp) return null;
  const spot = (await alpacaData.lastPrice(underlying, { allowStale: true }).catch(() => null)) ?? null; // strike selection only — a stale spot is fine here; the contract itself must still have a live two-sided quote to trade
  // Fail closed if we can't price the underlying — don't silently pick a median
  // strike and then mislabel it as the requested moneyness.
  if (!spot) return null;
  const { calls, puts } = await getChain(underlying, exp);
  const list = type === 'call' ? calls : puts;
  if (!list.length) return null;
  const tgt = targetPrice(spot, type, strikeTarget || 'atm');
  const fieldsOf = (x: OptContract) => ({ mid: x.mid, bid: x.bid, ask: x.ask, last: x.last, close: x.close_price });
  const c = pickNearestContract(list, tgt, fieldsOf, 'buy', { strict: opts.strictPrice === true });
  if (!c) return null;
  return {
    occSymbol: c.symbol, type, strike: c.strike, expiration: exp,
    bid: c.bid ?? null, ask: c.ask ?? null, mid: c.mid ?? null, spot,
    last: c.last ?? null, close: c.close_price ?? null,
    readable: `${underlying} ${readableExp(exp)} $${c.strike} ${type}`,
  };
}

/** Resolve a tradable contract from ROBINHOOD's own chain (for live RH execution). Picks
 *  the nearest RH-listed strike to the moneyness target around the requested expiration,
 *  so a QuickBot's Alpaca-derived target still lands on a real RH contract. Prices the
 *  resulting OCC off Alpaca's options feed (real, env-agnostic market data). Falls back to
 *  the Alpaca resolver if RH can't resolve — callers still fail closed if neither works. */
export async function resolveContractRH(
  underlying: string, type: 'call' | 'put', strikeTarget: string, expirationPref: string,
  opts: ResolveContractOpts = {},
): Promise<ResolvedContract | null> {
  underlying = underlying.toUpperCase();
  const spot = (await alpacaData.lastPrice(underlying, { allowStale: true }).catch(() => null)) ?? null; // strike selection only — a stale spot is fine here; the contract itself must still have a live two-sided quote to trade
  if (!spot) return resolveContract(underlying, type, strikeTarget, expirationPref, opts);
  // Target expiration as an explicit date (QuickBots pass a YYYY-MM-DD DTE date).
  const targetExp = /^\d{4}-\d{2}-\d{2}$/.test(expirationPref) ? expirationPref : new Date(Date.now() + 5 * 864e5).toISOString().slice(0, 10);
  const targetStrike = targetPrice(spot, type, strikeTarget || 'atm');
  try {
    const { rh } = await import('../rh/mcpClient.js');
    if (!rh.isConnected()) return resolveContract(underlying, type, strikeTarget, expirationPref, opts);
    const hit = await rh.resolveTradableOption(underlying, type, targetStrike, targetExp);
    if (!hit) return resolveContract(underlying, type, strikeTarget, expirationPref, opts);
    // RH nearest-listed can land on 0–1 DTE; refuse that unless this bot is privileged.
    const picked = pickListedExpiration([hit.expiration], {
      pref: hit.expiration,
      targetDte: opts.targetDte,
      allowShortDte: opts.allowShortDte === true,
      now: opts.now,
      name: opts.name,
      key: opts.key,
    });
    if (!picked) return resolveContract(underlying, type, strikeTarget, expirationPref, opts);
    const occ = buildOcc(underlying, hit.expiration, type, hit.strike);
    const qq = await latestQuotes([occ]).catch(() => ({}));
    const qhit = lookupByOcc(qq as Record<string, any>, occ) || (qq as any)[occ];
    if (opts.strictPrice === true) {
      const prem = optionPremium(
        { mid: qhit?.mid, ask: qhit?.ask, bid: qhit?.bid, last: qhit?.last, close: qhit?.close },
        'buy',
        { strict: true },
      );
      if (!prem.placeable) return resolveContract(underlying, type, strikeTarget, expirationPref, opts);
    }
    return {
      occSymbol: occ, type, strike: hit.strike, expiration: hit.expiration,
      bid: qhit?.bid ?? null, ask: qhit?.ask ?? null, mid: qhit?.mid ?? null, spot,
      last: qhit?.last ?? null, close: qhit?.close ?? null,
      readable: `${underlying} ${readableExp(hit.expiration)} $${hit.strike} ${type}`, instrumentId: hit.instrumentId,
    };
  } catch {
    return resolveContract(underlying, type, strikeTarget, expirationPref, opts);
  }
}

/** Historical daily bars for a contract (sparse on indicative feed). */
export async function optionBars(symbol: string, start: string, end?: string): Promise<any[]> {
  const u = `${DATA()}/options/bars?symbols=${encodeURIComponent(symbol)}&timeframe=1Day&start=${start}${end ? `&end=${end}` : ''}`;
  const res = await get(u).catch(() => ({}));
  return res?.bars?.[symbol] || [];
}
