// ─────────────────────────────────────────────────────────────────────────────
// Index & commodity FUTURES — real quotes (incl. the overnight session, when the
// cash market is closed but futures lead the next open). Futures are a forward
// indicator of the underlying ETF, so we map each to its ETF. Data: Yahoo Finance
// public quote endpoint (real, free; not Alpaca/RH which don't carry futures here).
// ─────────────────────────────────────────────────────────────────────────────

export type FutureQuote = {
  future: string;        // e.g. ES=F
  name: string;          // E-mini S&P 500
  proxy: string;         // underlying ETF this leads (SPY)
  price: number | null;
  change: number | null;
  changePct: number | null;
  prevClose: number | null;
  marketState: string | null; // REGULAR | OVERNIGHT
  asOf: number | null;
  ok: boolean;    // false when the quote couldn't be fetched
  stale: boolean; // true when the last quote is older than ~20 min
};

// Futures → the ETF they lead. ES/NQ/YM/RTY are the index e-minis; CL/GC are macro.
export const FUTURES: { future: string; name: string; proxy: string }[] = [
  { future: 'ES=F', name: 'E-mini S&P 500', proxy: 'SPY' },
  { future: 'NQ=F', name: 'E-mini Nasdaq 100', proxy: 'QQQ' },
  { future: 'YM=F', name: 'E-mini Dow', proxy: 'DIA' },
  { future: 'RTY=F', name: 'E-mini Russell 2000', proxy: 'IWM' },
  { future: 'CL=F', name: 'Crude Oil (WTI)', proxy: 'XLE' },
  { future: 'GC=F', name: 'Gold', proxy: 'GLD' },
];

/** The future that leads a given underlying ETF/symbol, if any. */
export function futureForSymbol(symbol: string): { future: string; name: string; proxy: string } | null {
  const s = symbol.toUpperCase();
  return FUTURES.find((f) => f.proxy === s) || null;
}

const num = (v: any): number | null => (Number.isFinite(Number(v)) ? Number(v) : null);

/** Fetch one real quote via Yahoo's v8 chart endpoint (no crumb/cookie needed).
 *  range=1d so chartPreviousClose is the PRIOR SESSION settle — the right reference
 *  for the overnight/today % move (range=2d points at the wrong session). */
async function fetchChartQuote(sym: string): Promise<{ price: number | null; prevClose: number | null; time: number | null } | null> {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?interval=1d&range=1d`;
  try {
    const r = await fetch(url, { headers: { 'user-agent': 'Mozilla/5.0', accept: 'application/json' } });
    if (!r.ok) return null;
    const j: any = await r.json();
    const meta = j?.chart?.result?.[0]?.meta;
    if (!meta) return null;
    return {
      price: num(meta.regularMarketPrice),
      prevClose: num(meta.previousClose ?? meta.chartPreviousClose),
      time: num(meta.regularMarketTime) ? Number(meta.regularMarketTime) * 1000 : null,
    };
  } catch {
    return null;
  }
}

// Crypto — TRACKED as macro/risk-appetite indicators only. NEVER traded (the risk
// engine hard-blocks crypto orders); shown for context (BTC/ETH lead risk sentiment).
export const CRYPTO = [
  { symbol: 'BTC-USD', name: 'Bitcoin' },
  { symbol: 'ETH-USD', name: 'Ethereum' },
];

export type IndicatorQuote = {
  symbol: string; name: string; price: number | null; change: number | null;
  changePct: number | null; prevClose: number | null; asOf: number | null; ok: boolean; stale: boolean;
};

function buildQuote(symbol: string, name: string, q: { price: number | null; prevClose: number | null; time: number | null } | null): IndicatorQuote {
  const price = q?.price ?? null;
  const prev = q?.prevClose ?? null;
  const change = price != null && prev != null ? Math.round((price - prev) * 100) / 100 : null;
  const changePct = price != null && prev != null && prev !== 0 ? Math.round(((price - prev) / prev) * 10000) / 100 : null;
  const asOf = q?.time ?? null;
  return { symbol, name, price, change, changePct, prevClose: prev, asOf, ok: price != null, stale: asOf != null ? Date.now() - asOf > 20 * 60_000 : true };
}

/** Real BTC/ETH quotes — indicators only, never tradable. */
export async function getCrypto(): Promise<IndicatorQuote[]> {
  const qs = await Promise.all(CRYPTO.map((c) => fetchChartQuote(c.symbol)));
  return CRYPTO.map((c, i) => buildQuote(c.symbol, c.name, qs[i]));
}

// Server-side cache so many dashboard clients don't each hammer Yahoo's public
// endpoint (rate-limit / IP-block risk). One fetch shared for ~12s.
let _futCache: { data: any; ts: number } | null = null;
let _futInflight: Promise<any> | null = null;
const FUT_TTL = 12_000;

export async function getFutures(): Promise<{ futures: FutureQuote[]; crypto: IndicatorQuote[]; overnight: boolean; source: string }> {
  if (_futCache && Date.now() - _futCache.ts < FUT_TTL) return _futCache.data;
  if (_futInflight) return _futInflight;
  _futInflight = fetchFutures().then((d) => { _futCache = { data: d, ts: Date.now() }; return d; }).finally(() => { _futInflight = null; });
  return _futInflight;
}

async function fetchFutures(): Promise<{ futures: FutureQuote[]; crypto: IndicatorQuote[]; overnight: boolean; source: string }> {
  const { isMarketOpen } = await import('./clock.js');
  const open = await isMarketOpen().catch(() => false);
  const [quotes, crypto] = await Promise.all([
    Promise.all(FUTURES.map((f) => fetchChartQuote(f.future))),
    getCrypto(),
  ]);
  const nowMs = Date.now();
  const futures: FutureQuote[] = FUTURES.map((f, i) => {
    const q = quotes[i];
    const price = q?.price ?? null;
    const prev = q?.prevClose ?? null;
    const change = price != null && prev != null ? Math.round((price - prev) * 100) / 100 : null;
    const changePct = price != null && prev != null && prev !== 0 ? Math.round(((price - prev) / prev) * 10000) / 100 : null;
    const asOf = q?.time ?? null;
    return {
      future: f.future, name: f.name, proxy: f.proxy,
      price, change, changePct, prevClose: prev,
      marketState: open ? 'REGULAR' : 'OVERNIGHT',
      asOf,
      ok: price != null,
      // No timestamp → we can't vouch it's fresh, so flag it stale rather than imply live.
      stale: asOf != null ? nowMs - asOf > 20 * 60_000 : true,
    };
  });
  return { futures, crypto, overnight: !open, source: 'yahoo' };
}

/** The single leading future for a focus symbol (null if it isn't index/macro-led). */
export async function leadingFuture(symbol: string): Promise<FutureQuote | null> {
  const map = futureForSymbol(symbol);
  if (!map) return null;
  const { futures } = await getFutures();
  return futures.find((f) => f.future === map.future) || null;
}
