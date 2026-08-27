import { config } from '../config.js';
import { alpacaData } from './alpaca.js';

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

/** Latest quotes (bid/ask) for a batch of OCC symbols. */
export async function latestQuotes(symbols: string[]): Promise<Record<string, { bid: number; ask: number; mid: number }>> {
  const out: Record<string, { bid: number; ask: number; mid: number }> = {};
  for (let i = 0; i < symbols.length; i += 100) {
    const batch = symbols.slice(i, i + 100);
    const u = `${DATA()}/options/quotes/latest?symbols=${encodeURIComponent(batch.join(','))}&feed=indicative`;
    try {
      const res = await get(u);
      for (const [sym, q] of Object.entries<any>(res.quotes || {})) {
        const bid = Number(q.bp) || 0, ask = Number(q.ap) || 0;
        // Only a true two-sided market yields a real mid; a one-sided quote is not
        // a tradable mid, so leave mid null rather than overstate it.
        out[sym] = { bid, ask, mid: bid > 0 && ask > 0 ? Math.round(((bid + ask) / 2) * 100) / 100 : (null as any) };
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
  // Fall back to plain quotes for any contract the snapshot feed didn't cover.
  const missing = contracts.filter((c) => !snaps[c.symbol]).map((c) => c.symbol);
  const quotes = missing.length ? await latestQuotes(missing).catch(() => ({})) : {};
  for (const c of contracts) {
    const s = snaps[c.symbol];
    if (s) {
      const bp = Number(s.latestQuote?.bp) || 0, ap = Number(s.latestQuote?.ap) || 0;
      c.bid = bp || null; c.ask = ap || null;
      // Real mid only from a two-sided market; one-sided → null (don't overstate).
      c.mid = bp > 0 && ap > 0 ? Math.round(((bp + ap) / 2) * 100) / 100 : null;
      c.last = s.latestTrade?.p != null ? Number(s.latestTrade.p) : null;
      c.iv = s.impliedVolatility != null ? Number(s.impliedVolatility) : null;
      const g = s.greeks || {};
      c.delta = num(g.delta); c.gamma = num(g.gamma); c.theta = num(g.theta); c.vega = num(g.vega); c.rho = num(g.rho);
    } else if ((quotes as any)[c.symbol]) {
      const qq = (quotes as any)[c.symbol];
      c.bid = qq.bid; c.ask = qq.ask; c.mid = qq.mid;
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

/** Real current price (mid, else close) for a single contract. */
export async function contractPrice(symbol: string): Promise<number | null> {
  const q = await latestQuotes([symbol]);
  if (q[symbol]?.mid) return q[symbol].mid;
  return null;
}

export type ResolvedContract = {
  occSymbol: string; type: 'call' | 'put'; strike: number; expiration: string;
  bid: number | null; ask: number | null; mid: number | null; spot: number | null;
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

/** Pick a concrete expiration from the real available list for a horizon preference. */
function pickExpiration2(exps: string[], pref: string): string {
  const now = Date.now();
  const dte = (e: string) => (Date.parse(e + 'T00:00:00Z') - now) / 864e5;
  if (/^\d{4}-\d{2}-\d{2}$/.test(pref)) return exps.find((e) => e >= pref) || exps[exps.length - 1];
  const future = exps.filter((e) => dte(e) >= 2);
  if (!future.length) return exps[exps.length - 1];
  if (pref === 'monthly') return future.reduce((b, e) => (Math.abs(dte(e) - 32) < Math.abs(dte(b) - 32) ? e : b));
  if (pref === 'leaps') return future.reduce((b, e) => (dte(e) > dte(b) ? e : b)); // furthest
  return future[0]; // weekly: soonest standard
}

function targetPrice(spot: number, type: 'call' | 'put', strikeTarget: string): number {
  if (strikeTarget === 'atm' || !spot) return spot;
  const otm = strikeTarget === 'otm';
  // OTM call = above spot, OTM put = below; ITM is the inverse.
  const up = (type === 'call') === otm; // call+otm→up, put+otm→down, call+itm→down, put+itm→up
  return up ? spot * 1.05 : spot * 0.95;
}

const readableExp = (iso: string) => new Date(iso + 'T00:00:00').toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });

/**
 * Resolve a target (type + strikeTarget + expiration horizon) to a CONCRETE, real
 * tradable contract from the live chain. Returns null if nothing resolves — callers
 * MUST fail closed rather than guess. Shared by Alpaca + Robinhood placement.
 */
export async function resolveContract(
  underlying: string, type: 'call' | 'put', strikeTarget: string, expirationPref: string,
): Promise<ResolvedContract | null> {
  underlying = underlying.toUpperCase();
  const exps = await expirations(underlying).catch(() => [] as string[]);
  if (!exps.length) return null;
  const exp = pickExpiration2(exps, expirationPref || 'monthly');
  const spot = (await alpacaData.lastPrice(underlying, { allowStale: true }).catch(() => null)) ?? null; // strike selection only — a stale spot is fine here; the contract itself must still have a live two-sided quote to trade
  // Fail closed if we can't price the underlying — don't silently pick a median
  // strike and then mislabel it as the requested moneyness.
  if (!spot) return null;
  const { calls, puts } = await getChain(underlying, exp);
  const list = type === 'call' ? calls : puts;
  if (!list.length) return null;
  const tgt = targetPrice(spot, type, strikeTarget || 'atm');
  const c = list.reduce((best, x) => (Math.abs(x.strike - tgt) < Math.abs(best.strike - tgt) ? x : best));
  return {
    occSymbol: c.symbol, type, strike: c.strike, expiration: exp,
    bid: c.bid ?? null, ask: c.ask ?? null, mid: c.mid ?? null, spot,
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
): Promise<ResolvedContract | null> {
  underlying = underlying.toUpperCase();
  const spot = (await alpacaData.lastPrice(underlying, { allowStale: true }).catch(() => null)) ?? null; // strike selection only — a stale spot is fine here; the contract itself must still have a live two-sided quote to trade
  if (!spot) return resolveContract(underlying, type, strikeTarget, expirationPref);
  // Target expiration as an explicit date (QuickBots pass a YYYY-MM-DD DTE date).
  const targetExp = /^\d{4}-\d{2}-\d{2}$/.test(expirationPref) ? expirationPref : new Date(Date.now() + 5 * 864e5).toISOString().slice(0, 10);
  const targetStrike = targetPrice(spot, type, strikeTarget || 'atm');
  try {
    const { rh } = await import('../rh/mcpClient.js');
    if (!rh.isConnected()) return resolveContract(underlying, type, strikeTarget, expirationPref);
    const hit = await rh.resolveTradableOption(underlying, type, targetStrike, targetExp);
    if (!hit) return resolveContract(underlying, type, strikeTarget, expirationPref);
    const occ = buildOcc(underlying, hit.expiration, type, hit.strike);
    const qq = await latestQuotes([occ]).catch(() => ({}));
    const mid = (qq as any)[occ]?.mid ?? null;
    return {
      occSymbol: occ, type, strike: hit.strike, expiration: hit.expiration,
      bid: (qq as any)[occ]?.bid ?? null, ask: (qq as any)[occ]?.ask ?? null, mid, spot,
      readable: `${underlying} ${readableExp(hit.expiration)} $${hit.strike} ${type}`, instrumentId: hit.instrumentId,
    };
  } catch {
    return resolveContract(underlying, type, strikeTarget, expirationPref);
  }
}

/** Historical daily bars for a contract (sparse on indicative feed). */
export async function optionBars(symbol: string, start: string, end?: string): Promise<any[]> {
  const u = `${DATA()}/options/bars?symbols=${encodeURIComponent(symbol)}&timeframe=1Day&start=${start}${end ? `&end=${end}` : ''}`;
  const res = await get(u).catch(() => ({}));
  return res?.bars?.[symbol] || [];
}
