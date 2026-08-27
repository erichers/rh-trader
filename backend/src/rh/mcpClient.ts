import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js';
import { config } from '../config.js';
import { RhOAuthProvider } from './oauthProvider.js';

export type RhStatus = 'disconnected' | 'needs_auth' | 'connected' | 'error';

export type RhTool = { name: string; description?: string; inputSchema?: any };

// Heuristics: which MCP tools actually place/modify orders (must be gated).
const ORDER_WRITE_RE =
  /(place|create|submit|buy|sell|execute|cancel|replace|modify).*?(order|trade|position)|(order|trade).*?(place|submit|create|buy|sell|cancel)/i;

export function isOrderWriteTool(name: string): boolean {
  return ORDER_WRITE_RE.test(name);
}

class RobinhoodClient {
  status: RhStatus = 'disconnected';
  lastError: string | undefined;
  provider: RhOAuthProvider;
  private client: Client | undefined;
  private transport: StreamableHTTPClientTransport | undefined;
  private pendingTransport: StreamableHTTPClientTransport | undefined;
  private tools: RhTool[] = [];

  constructor() {
    this.provider = new RhOAuthProvider();
  }

  get authUrl(): string | undefined {
    return this.provider.lastAuthUrl?.toString();
  }

  /** Attempt to (re)connect using stored tokens. Never throws fatally. */
  async connect(): Promise<RhStatus> {
    try {
      this.client = new Client(
        { name: 'rh.tradingbot', version: '0.1.0' },
        { capabilities: {} },
      );
      this.transport = new StreamableHTTPClientTransport(new URL(config.rh.mcpUrl), {
        authProvider: this.provider,
      });
      await this.client.connect(this.transport);
      await this.refreshTools();
      this.status = 'connected';
      this.lastError = undefined;
    } catch (err: any) {
      if (err instanceof UnauthorizedError || /unauthor/i.test(err?.message || '')) {
        this.status = 'needs_auth';
      } else {
        this.status = 'error';
        this.lastError = err?.message || String(err);
      }
    }
    return this.status;
  }

  /** Begin interactive OAuth: returns the URL the user must visit to authorize. */
  async beginAuth(): Promise<{ authUrl?: string; alreadyConnected: boolean }> {
    // If stored tokens already work, no auth needed.
    if (await this.connect() === 'connected') return { alreadyConnected: true };
    const transport = new StreamableHTTPClientTransport(new URL(config.rh.mcpUrl), {
      authProvider: this.provider,
    });
    const client = new Client({ name: 'rh.tradingbot', version: '0.1.0' }, { capabilities: {} });
    try {
      await client.connect(transport);
      // Connected without redirect (tokens refreshed).
      this.client = client;
      this.transport = transport;
      await this.refreshTools();
      this.status = 'connected';
      return { alreadyConnected: true };
    } catch (err: any) {
      if (err instanceof UnauthorizedError || /unauthor/i.test(err?.message || '')) {
        this.pendingTransport = transport;
        this.status = 'needs_auth';
        return { authUrl: this.provider.lastAuthUrl?.toString(), alreadyConnected: false };
      }
      this.status = 'error';
      this.lastError = err?.message || String(err);
      throw err;
    }
  }

  /** Complete OAuth with the authorization code from the redirect. */
  async completeAuth(code: string): Promise<RhStatus> {
    const t = this.pendingTransport;
    if (!t) throw new Error('no pending auth — call beginAuth first');
    await t.finishAuth(code);
    this.pendingTransport = undefined;
    return this.connect();
  }

  async refreshTools(): Promise<RhTool[]> {
    if (!this.client) return [];
    const res = await this.client.listTools();
    this.tools = (res.tools || []).map((t: any) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    }));
    return this.tools;
  }

  listToolsCached(): RhTool[] {
    return this.tools;
  }

  isConnected(): boolean {
    return this.status === 'connected' && !!this.client;
  }

  /** Raw tool call. Returns parsed content (JSON if possible, else text). */
  async callTool(name: string, args: Record<string, any> = {}): Promise<any> {
    if (!this.client) throw new Error('Robinhood MCP not connected');
    const res: any = await this.client.callTool({ name, arguments: args });
    return extractContent(res);
  }

  /** Find the first tool whose name matches any of the given substrings. */
  findTool(...needles: string[]): RhTool | undefined {
    const lower = this.tools.map((t) => ({ t, n: t.name.toLowerCase() }));
    for (const needle of needles) {
      const hit = lower.find(({ n }) => n.includes(needle.toLowerCase()));
      if (hit) return hit.t;
    }
    return undefined;
  }

  async getAccounts(): Promise<any> {
    const t = this.findTool('get_accounts', 'list_accounts', 'get_account', 'accounts', 'account');
    return t ? this.callTool(t.name) : null;
  }

  /** Account balances/equity (buying power, cash, market value). Per account. */
  async getPortfolio(accountNumber: string): Promise<any> {
    const t = this.findTool('get_portfolio', 'portfolio');
    return t ? this.callTool(t.name, { account_number: accountNumber }) : null;
  }

  /** Equity + option positions, each tagged with __asset_class. */
  async getPositions(accountNumber: string): Promise<any[]> {
    const out: any[] = [];
    const eq = this.findTool('get_equity_positions');
    const op = this.findTool('get_option_positions');
    if (eq) for (const p of asRows(await this.callTool(eq.name, { account_number: accountNumber }))) out.push({ ...p, __asset_class: 'equity' });
    if (op) for (const p of asRows(await this.callTool(op.name, { account_number: accountNumber, nonzero: true }))) out.push({ ...p, __asset_class: 'option' });
    return out;
  }

  /** Equity + option orders, each tagged with __asset_class. */
  async getOrders(accountNumber: string): Promise<any[]> {
    const out: any[] = [];
    const eq = this.findTool('get_equity_orders');
    const op = this.findTool('get_option_orders');
    if (eq) for (const o of asRows(await this.callTool(eq.name, { account_number: accountNumber }))) out.push({ ...o, __asset_class: 'equity' });
    if (op) for (const o of asRows(await this.callTool(op.name, { account_number: accountNumber }))) out.push({ ...o, __asset_class: 'option' });
    return out;
  }

  async getQuote(symbol: string): Promise<any> {
    const t = this.findTool('quote', 'price', 'market_data', 'snapshot');
    return t ? this.callTool(t.name, { symbol }) : null;
  }

  /** Real-time equity quotes (last/bid/ask/prev close) for one or more symbols. */
  async getEquityQuotes(symbols: string[]): Promise<any> {
    const t = this.findTool('get_equity_quotes');
    return t ? this.callTool(t.name, { symbols }) : null;
  }

  /** Fundamentals (market cap, P/E, 52wk range, dividend yield, sector, etc.). */
  async getFundamentals(symbols: string[]): Promise<any> {
    const t = this.findTool('get_equity_fundamentals');
    return t ? this.callTool(t.name, { symbols }) : null;
  }

  /** Upcoming earnings calendar (next N days). */
  async getEarningsCalendar(days = 14): Promise<any> {
    const t = this.findTool('get_earnings_calendar');
    return t ? this.callTool(t.name, { days }) : null;
  }

  /** Historical earnings results (EPS estimate vs actual) for a symbol. */
  async getEarningsResults(symbol: string): Promise<any> {
    const t = this.findTool('get_earnings_results');
    return t ? this.callTool(t.name, { symbol }) : null;
  }

  /** Resolve a concrete tradable option instrument UUID by chain/expiration/type/strike. */
  async getOptionInstrumentId(chainSymbol: string, expiration: string, type: 'call' | 'put', strike: number): Promise<string | null> {
    const t = this.findTool('get_option_instruments');
    if (!t) return null;
    const res = await this.callTool(t.name, {
      chain_symbol: chainSymbol.toUpperCase(), expiration_dates: expiration, type,
      strike_price: strike.toFixed(4), state: 'active', tradability: 'tradable',
    });
    const rows = asRows(res);
    // EXACT match only — never fall back to rows[0], which could be a different
    // strike/expiration/type and place an order on the wrong live contract.
    const hit = rows.find((r: any) => Math.abs(Number(r.strike_price) - strike) < 1e-6 && (!r.type || r.type === type));
    return hit ? String(hit.id || hit.instrument_id || hit.uuid || '') || null : null;
  }

  /** Resolve the NEAREST tradable RH contract to a target (ATM) strike around a target
   *  expiration — so a QuickBot's DTE/strike picked from Alpaca data still resolves to a
   *  real Robinhood-listed contract even if RH's exact strike/date differs slightly. Tries
   *  the target date then nearby days; within a date, snaps to the closest listed strike.
   *  Returns the ACTUAL contract placed (so monitors/exits track the right OCC). */
  async resolveTradableOption(chainSymbol: string, type: 'call' | 'put', targetStrike: number, targetExpISO: string):
    Promise<{ instrumentId: string; strike: number; expiration: string } | null> {
    const instTool = this.findTool('get_option_instruments');
    if (!instTool) return null;
    chainSymbol = chainSymbol.toUpperCase();

    // 1. Ask RH for the chain's REAL listed expirations (don't guess nearby dates).
    let expirations: string[] = [];
    try {
      const chains = await this.callTool('get_option_chains', { underlying_symbol: chainSymbol });
      const rows = asRows(chains);
      const chain = rows.find((c: any) => Array.isArray(c?.expiration_dates)) || rows[0];
      expirations = (chain?.expiration_dates || []).filter((s: any) => /^\d{4}-\d{2}-\d{2}$/.test(s)).sort();
    } catch { /* fall through to the target date alone */ }
    if (!expirations.length) expirations = [targetExpISO];

    // 2. Pick the nearest listed expiration on/after the target, else the nearest overall.
    const tMs = Date.parse(targetExpISO + 'T00:00:00Z');
    const onAfter = expirations.filter((e) => Date.parse(e + 'T00:00:00Z') >= tMs);
    const ranked = (onAfter.length ? onAfter : expirations)
      .sort((a, b) => Math.abs(Date.parse(a) - tMs) - Math.abs(Date.parse(b) - tMs));

    // 3. Find the ATM-nearest TRADABLE strike by querying SPECIFIC strikes (a strike-less
    //    query returns a paginated/truncated list that can omit the ATM strike entirely).
    //    Try the rounded ATM strike then widening offsets to cover $0.5/$1/$2.5/$5 chains.
    const base = Math.round(targetStrike);
    const offsets = [0, 1, -1, 2, -2, 0.5, -0.5, 2.5, -2.5, 5, -5, 3, -3, 4, -4, 7.5, -7.5, 10, -10];
    // CRITICAL: try the strikes that are genuinely CLOSEST to the (ATM) target first, so we
    // snap to the true ATM listed strike. Without this sort, the integer-first offset order
    // returns a $5/$10-boundary integer (e.g. 280/340) before the nearer half-dollar strike
    // (282.5/337.5) on $2.5-increment chains — landing ~$2.5 off ATM vs the Alpaca resolver.
    const strikeCands = [...new Set(offsets.map((o) => Math.round((base + o) * 100) / 100).filter((s) => s > 0))]
      .sort((a, b) => Math.abs(a - targetStrike) - Math.abs(b - targetStrike));
    for (const exp of ranked.slice(0, 2)) {
      for (const strike of strikeCands) {
        let rows: any[] = [];
        try {
          const res = await this.callTool(instTool.name, { chain_symbol: chainSymbol, expiration_dates: exp, type, strike_price: strike.toFixed(4), state: 'active', tradability: 'tradable' });
          rows = asRows(res).filter((r: any) => r && r.strike_price != null && Math.abs(Number(r.strike_price) - strike) < 1e-6 && (!r.type || r.type === type));
        } catch { rows = []; }
        const hit = rows[0];
        const id = hit && (hit.id || hit.instrument_id || hit.uuid);
        if (id) return { instrumentId: String(id), strike: Number(hit.strike_price), expiration: String(hit.expiration_date || exp) };
      }
    }
    return null;
  }

  /** Place a single-leg option order on the agentic account. Long-only buy-to-open
   *  / sell-to-close. Uses a limit order at the given price for a controlled fill. */
  async placeOptionOrder(opts: {
    accountNumber: string; optionId: string; side: 'buy' | 'sell';
    positionEffect: 'open' | 'close'; quantity: number; price?: number; refId?: string;
  }): Promise<any> {
    const t = this.findTool('place_option_order');
    if (!t) throw new Error('Robinhood MCP has no place_option_order tool');
    const args: Record<string, any> = {
      account_number: opts.accountNumber,
      legs: [{ option_id: opts.optionId, side: opts.side, position_effect: opts.positionEffect, ratio_quantity: 1 }],
      quantity: String(Math.max(1, Math.round(opts.quantity))),
      time_in_force: 'gfd',
    };
    if (opts.price != null) { args.type = 'limit'; args.price = opts.price.toFixed(2); }
    else { args.type = 'market'; }
    if (opts.refId) args.ref_id = opts.refId;
    return this.callTool(t.name, args);
  }

  async disconnect(): Promise<void> {
    try {
      await this.transport?.close();
    } catch {
      /* ignore */
    }
    this.status = 'disconnected';
  }
}

/** Unwrap the various list shapes the RH MCP returns into a flat array of rows.
 *  Responses are commonly nested under data.{accounts|positions|orders|results|instruments|chains}. */
export function asRows(x: any): any[] {
  if (x == null) return [];
  if (Array.isArray(x)) return x;
  const d = x.data ?? x;
  // NOTE: `instruments`/`option_instruments`/`chains` are REQUIRED here — get_option_instruments
  // returns {data:{instruments:[...]}}, and without this key the option resolver finds nothing
  // and every RH option order fails closed with "no tradable instrument".
  for (const k of ['accounts', 'positions', 'orders', 'results', 'equity_positions', 'option_positions', 'instruments', 'option_instruments', 'chains']) {
    if (Array.isArray(d?.[k])) return d[k];
    if (Array.isArray(x?.[k])) return x[k];
  }
  return [x];
}

function extractContent(res: any): any {
  if (!res) return null;
  if (res.structuredContent !== undefined) return res.structuredContent;
  const parts = res.content || [];
  const texts: string[] = [];
  for (const p of parts) {
    if (p?.type === 'text' && typeof p.text === 'string') texts.push(p.text);
  }
  const joined = texts.join('\n').trim();
  if (!joined) return res.content ?? null;
  try {
    return JSON.parse(joined);
  } catch {
    return joined;
  }
}

export const rh = new RobinhoodClient();
