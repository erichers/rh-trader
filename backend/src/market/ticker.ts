import { q, getTradingEnv } from '../db.js';
import { rh, asRows } from '../rh/mcpClient.js';
import { alpacaData, alpacaConfigured } from '../brokers/alpaca.js';
import { refreshBars } from '../brokers/index.js';
import { analyzeSymbolStats } from './analyze.js';
import { expirations as optExpirations } from '../brokers/options.js';

function pick(o: any, keys: string[], d: any = null): any {
  for (const k of keys) if (o && o[k] != null) return o[k];
  return d;
}
function n(v: any): number | null {
  if (v == null) return null;
  const x = Number(v);
  return Number.isFinite(x) ? x : null;
}

// Short-TTL last-price cache so enriching positions/quotes on every poll doesn't
// hammer the data feed (many UI clients polling every few seconds).
const _priceCache = new Map<string, { price: number | null; ts: number }>();
const _inflight = new Map<string, Promise<number | null>>();
const PRICE_TTL = 5000;      // good quotes cached 5s
const NULL_TTL = 1000;       // don't pin a transient outage for the full 5s
const CACHE_MAX = 500;       // bound the Map (LRU-ish prune)

/** Live last price for an equity/ETF, cached. Single-flight: concurrent callers for
 *  the same symbol share one fetch. Returns null if unavailable. */
export async function lastPriceCached(symbol: string): Promise<number | null> {
  symbol = symbol.toUpperCase();
  const hit = _priceCache.get(symbol);
  if (hit && Date.now() - hit.ts < (hit.price == null ? NULL_TTL : PRICE_TTL)) return hit.price;
  const pending = _inflight.get(symbol);
  if (pending) return pending;
  const p = (async () => {
    let price: number | null = null;
    if (alpacaConfigured()) price = await alpacaData.lastPrice(symbol).catch(() => null);
    if (_priceCache.size > CACHE_MAX) { // prune oldest ~half
      const old = [..._priceCache.entries()].sort((a, b) => a[1].ts - b[1].ts).slice(0, CACHE_MAX / 2);
      for (const [k] of old) _priceCache.delete(k);
    }
    _priceCache.set(symbol, { price, ts: Date.now() });
    return price;
  })().finally(() => _inflight.delete(symbol));
  _inflight.set(symbol, p);
  return p;
}

/** Batch live prices for a set of symbols (cached). */
export async function livePrices(symbols: string[]): Promise<Record<string, number | null>> {
  const uniq = [...new Set(symbols.map((s) => s.toUpperCase()))];
  const out: Record<string, number | null> = {};
  await Promise.all(uniq.map(async (s) => { out[s] = await lastPriceCached(s); }));
  return out;
}

export type LiveQuote = {
  symbol: string;
  price: number | null;
  bid: number | null;
  ask: number | null;
  prevClose: number | null;
  change: number | null;
  changePct: number | null;
  source: string;
};

/** Best real-time quote: Robinhood when connected (richer), else Alpaca IEX. */
export async function liveQuote(symbol: string): Promise<LiveQuote> {
  symbol = symbol.toUpperCase();
  const out: LiveQuote = { symbol, price: null, bid: null, ask: null, prevClose: null, change: null, changePct: null, source: 'none' };

  if (rh.isConnected()) {
    try {
      const rows = asRows(await rh.getEquityQuotes([symbol]));
      const r = rows[0];
      if (r) {
        out.price = n(pick(r, ['last_trade_price', 'last_non_reg_trade_price', 'price', 'mark_price', 'last_extended_hours_trade_price']));
        out.bid = n(pick(r, ['bid_price', 'bid']));
        out.ask = n(pick(r, ['ask_price', 'ask']));
        out.prevClose = n(pick(r, ['previous_close', 'adjusted_previous_close', 'prev_close']));
        out.source = 'robinhood';
      }
    } catch { /* fall through to Alpaca */ }
  }

  if (out.price == null && alpacaConfigured()) {
    try {
      out.price = await alpacaData.lastPrice(symbol);
      const qd = await alpacaData.latestQuote(symbol).catch(() => null);
      out.bid = n(qd?.quote?.bp);
      out.ask = n(qd?.quote?.ap);
      out.source = 'alpaca-iex'; // IEX feed (~3% of tape) — labeled so it's not read as consolidated NBBO
    } catch { /* ignore */ }
  }

  // Previous close from cached/real daily bars when the quote feed didn't give it.
  if (out.prevClose == null) {
    const closes = await refreshBars(symbol, '1Day', 3).catch(() => [] as number[]);
    if (closes.length >= 2) out.prevClose = closes[closes.length - 2];
    if (out.price == null && closes.length) out.price = closes[closes.length - 1];
  }
  if (out.price != null && out.prevClose != null && out.prevClose !== 0) {
    out.change = Math.round((out.price - out.prevClose) * 100) / 100;
    out.changePct = Math.round(((out.price - out.prevClose) / out.prevClose) * 10000) / 100;
  }
  return out;
}

/** Curated fundamentals from Robinhood (real data when connected). */
export async function fundamentals(symbol: string): Promise<any | null> {
  if (!rh.isConnected()) return null;
  try {
    const rows = asRows(await rh.getFundamentals([symbol.toUpperCase()]));
    const f = rows[0];
    if (!f) return null;
    return {
      market_cap: n(pick(f, ['market_cap'])),
      pe_ratio: n(pick(f, ['pe_ratio'])),
      pb_ratio: n(pick(f, ['pb_ratio'])),
      dividend_yield: n(pick(f, ['dividend_yield'])),
      high_52w: n(pick(f, ['high_52_weeks', 'high_52w'])),
      low_52w: n(pick(f, ['low_52_weeks', 'low_52w'])),
      avg_volume: n(pick(f, ['average_volume', 'average_volume_2_weeks'])),
      volume: n(pick(f, ['volume'])),
      open: n(pick(f, ['open'])),
      high: n(pick(f, ['high'])),
      low: n(pick(f, ['low'])),
      shares_outstanding: n(pick(f, ['shares_outstanding'])),
      sector: pick(f, ['sector']),
      industry: pick(f, ['industry']),
      description: pick(f, ['description']),
      ceo: pick(f, ['ceo']),
      num_employees: n(pick(f, ['num_employees'])),
      headquarters: [pick(f, ['headquarters_city']), pick(f, ['headquarters_state'])].filter(Boolean).join(', ') || null,
      raw: f,
    };
  } catch {
    return null;
  }
}

/**
 * Everything the app knows about a symbol — the data behind the ticker detail
 * hub. Pulls live quote + fundamentals (RH), 3-mo stats (Alpaca), and the user's
 * own positions / bots / news / research / earnings for that symbol from the DB.
 */
export async function tickerOverview(symbol: string): Promise<any> {
  symbol = symbol.toUpperCase();
  const env = await getTradingEnv();
  const [quote, fund, stats, exps, positions, bots, news, notes, earnings, onWatch] = await Promise.all([
    liveQuote(symbol),
    fundamentals(symbol),
    analyzeSymbolStats(symbol, 90).catch(() => null),
    optExpirations(symbol).catch(() => [] as string[]),
    q('SELECT * FROM positions WHERE env=:env AND symbol=:s', { env, s: symbol }),
    q(`SELECT id,name,enabled,mode,asset_class,symbols,last_evaluated_at FROM bots
       WHERE env=:env AND JSON_SEARCH(symbols, 'one', :s) IS NOT NULL ORDER BY enabled DESC, id DESC`, { env, s: symbol }),
    q('SELECT id,headline,source,url,published_at FROM news WHERE symbol=:s ORDER BY published_at DESC LIMIT 8', { s: symbol }),
    q('SELECT * FROM research_notes WHERE symbol=:s ORDER BY updated_at DESC LIMIT 6', { s: symbol }),
    q('SELECT * FROM earnings WHERE symbol=:s ORDER BY report_date DESC LIMIT 4', { s: symbol }),
    q('SELECT symbol FROM watchlist WHERE symbol=:s', { s: symbol }),
  ]);
  return {
    symbol,
    quote,
    fundamentals: fund,
    stats,
    expirations: (exps as string[]).slice(0, 12),
    hasOptions: (exps as string[]).length > 0,
    onWatchlist: (onWatch as any[]).length > 0,
    positions,
    bots,
    news,
    notes,
    earnings,
  };
}
