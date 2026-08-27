import { config } from '../config.js';

// Alpaca REST client (trading + market data). Used for paper testing and as the
// real-bars market-data source for indicators/bots.

function headers() {
  return {
    'APCA-API-KEY-ID': config.alpaca.apiKey,
    'APCA-API-SECRET-KEY': config.alpaca.secretKey,
    'content-type': 'application/json',
  };
}

export function alpacaConfigured(): boolean {
  return !!config.alpaca.apiKey && !!config.alpaca.secretKey;
}

async function call(base: string, path: string, init?: RequestInit): Promise<any> {
  const r = await fetch(`${base}${path}`, { ...init, headers: headers() });
  const text = await r.text();
  let body: any = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  if (!r.ok) throw new Error(`alpaca ${r.status}: ${typeof body === 'string' ? body : JSON.stringify(body)}`);
  return body;
}

export class AlpacaClient {
  constructor(private live: boolean) {}
  private get tradeBase() {
    return this.live ? config.alpaca.liveBaseUrl : config.alpaca.paperBaseUrl;
  }

  account() {
    return call(this.tradeBase, '/account');
  }
  positions() {
    return call(this.tradeBase, '/positions');
  }
  orders(status = 'all', limit = 100) {
    return call(this.tradeBase, `/orders?status=${status}&limit=${limit}&direction=desc`);
  }

  /** Place a long order. Maps our draft to Alpaca's schema. Long-only by design. */
  async place(draft: {
    symbol: string;
    side: 'buy' | 'sell';
    qty: number;
    order_type?: string;
    limit_price?: number;
    stop_price?: number;
  }): Promise<any> {
    const body: any = {
      symbol: draft.symbol,
      qty: String(draft.qty),
      side: draft.side,
      type: draft.order_type === 'stop_limit' ? 'stop_limit' : draft.order_type || 'market',
      time_in_force: 'day',
    };
    if (draft.limit_price != null) body.limit_price = String(draft.limit_price);
    if (draft.stop_price != null) body.stop_price = String(draft.stop_price);
    return call(this.tradeBase, '/orders', { method: 'POST', body: JSON.stringify(body) });
  }

  /** Place a single-leg option order by OCC symbol (long-only buy/sell-to-close). */
  async placeOption(opts: { occSymbol: string; qty: number; side: 'buy' | 'sell'; limit_price?: number }): Promise<any> {
    const body: any = {
      symbol: opts.occSymbol,
      qty: String(Math.max(1, Math.round(opts.qty))),
      side: opts.side,
      time_in_force: 'day',
    };
    if (opts.limit_price != null && opts.limit_price > 0) { body.type = 'limit'; body.limit_price = opts.limit_price.toFixed(2); }
    else body.type = 'market';
    return call(this.tradeBase, '/orders', { method: 'POST', body: JSON.stringify(body) });
  }

  cancelAll() {
    return call(this.tradeBase, '/orders', { method: 'DELETE' });
  }

  /** Market clock: { timestamp, is_open, next_open, next_close } (handles holidays). */
  clock() {
    return call(this.tradeBase, '/clock');
  }

  /** Trading calendar between two ISO dates (inclusive). A date missing from the
   *  response was NOT a session day (weekend or market holiday). */
  calendar(start: string, end: string): Promise<any[]> {
    return call(this.tradeBase, `/calendar?start=${start}&end=${end}`);
  }

  /** Real account equity time series. Returns { timestamp[], equity[], profit_loss[],
   *  profit_loss_pct[], base_value }. Used for windowed P/L on the dashboard. */
  portfolioHistory(period = '1A', timeframe = '1D'): Promise<any> {
    return call(this.tradeBase, `/account/portfolio/history?period=${period}&timeframe=${timeframe}`);
  }

  /** Daily bars for a symbol (market data — works with paper keys, real data). */
  async bars(symbol: string, timeframe = '1Day', limit = 120): Promise<number[]> {
    return (await this.barsRaw(symbol, timeframe, limit))
      .map((b: any) => Number(b.c))
      .filter((n: number) => Number.isFinite(n));
  }

  async barsRaw(symbol: string, timeframe = '1Day', limit = 120): Promise<any[]> {
    // Alpaca requires a start date; widen for weekends/holidays then trim to `limit`.
    const calDays = timeframe === '1Day' ? Math.ceil(limit * 1.6) : limit;
    const start = new Date(Date.now() - calDays * 864e5).toISOString().slice(0, 10);
    const url = `${config.alpaca.dataUrl}/stocks/${encodeURIComponent(symbol)}/bars?timeframe=${timeframe}&start=${start}&limit=10000&adjustment=raw&feed=iex`;
    const res = await call('', url);
    const bars = res?.bars || [];
    return bars.slice(-limit);
  }

  /** Real market news (Alpaca news API). */
  async news(symbols?: string[], limit = 50): Promise<any[]> {
    const sym = symbols && symbols.length ? `&symbols=${symbols.join(',')}` : '';
    const url = `${config.alpaca.dataUrl.replace('/v2', '/v1beta1')}/news?limit=${limit}&sort=desc${sym}`;
    const res = await call('', url);
    return res?.news || [];
  }

  async latestQuote(symbol: string): Promise<any> {
    const url = `${config.alpaca.dataUrl}/stocks/${encodeURIComponent(symbol)}/quotes/latest?feed=iex`;
    return call('', url);
  }

  /** Latest trade price for an equity/ETF (IEX feed). */
  async lastPrice(symbol: string, opts?: { allowStale?: boolean }): Promise<number | null> {
    try {
      const res = await call('', `${config.alpaca.dataUrl}/stocks/${encodeURIComponent(symbol)}/trades/latest?feed=iex`);
      const p = res?.trade?.p;
      // Honesty guard (2026-08-24 audit): IEX replays the last session's print when the
      // market is closed — Friday's close was being shown pre-market as "LIVE" and skewed
      // displayed P/L ~$1.4k vs broker marks. Only report a trade fresher than 15 min;
      // callers (position overlay, monitors) fall back to broker marks / skip the cycle.
      const t = Date.parse(res?.trade?.t || '');
      if (!opts?.allowStale && Number.isFinite(t) && Date.now() - t > 15 * 60_000) return null;
      return Number.isFinite(Number(p)) ? Number(p) : null;
    } catch {
      return null;
    }
  }
}

export const alpacaPaper = new AlpacaClient(false);
export const alpacaLive = new AlpacaClient(true);
// Data always uses the (paper-or-live agnostic) data API; reuse paper client.
export const alpacaData = alpacaPaper;
