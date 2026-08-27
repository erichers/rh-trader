import { exec, audit, getTradingEnv, getKillSwitch, q } from '../db.js';
import { isLiveEnv, isCryptoSymbol, type TradingEnv } from '../config.js';
import { alpacaPaper, alpacaData, alpacaConfigured, AlpacaClient } from './alpaca.js';
import { rh, isOrderWriteTool } from '../rh/mcpClient.js';
import { syncAll as rhSyncAll, activeRhAccountNumber } from '../rh/sync.js';

const activeRhAccount = activeRhAccountNumber;

export type BrokerKind = 'alpaca' | 'robinhood';

export function brokerKind(env: TradingEnv): BrokerKind {
  return env === 'robinhood_live' ? 'robinhood' : 'alpaca';
}

function alpacaFor(_env: TradingEnv): AlpacaClient {
  return alpacaPaper; // only paper is supported
}

export async function brokerStatus(): Promise<any> {
  const env = await getTradingEnv();
  const kind = brokerKind(env);
  return {
    env,
    live: isLiveEnv(env),
    kind,
    alpacaConfigured: alpacaConfigured(),
    robinhood: rh.status,
    ready: kind === 'alpaca' ? alpacaConfigured() : rh.isConnected(),
  };
}

/** Place an order via the active broker. Risk gate runs upstream; this layer adds
 *  a FAIL-CLOSED re-check (defense-in-depth) so nothing reaches a real broker that
 *  trips the kill switch, is crypto, is an unsupported option order, or would short. */
export async function placeOrder(draft: {
  symbol: string;
  asset_class?: string;
  side: 'buy' | 'sell';
  qty: number;
  order_type?: string;
  limit_price?: number;
  stop_price?: number;
  option_type?: 'call' | 'put';
  expiration?: string;
  strike_target?: string;
}, envArg?: TradingEnv): Promise<{ rhOrderId?: string; raw: any }> {
  const env = envArg ?? (await getTradingEnv());

  // ── Fail-closed broker-boundary guards (independent of the upstream risk gate) ──
  // The kill switch blocks NEW exposure (buys) but must let close-only SELLS through —
  // they are the automated downside protection (stop-loss/take-profit/trailing/flatten).
  if (await getKillSwitch() && draft.side !== 'sell') throw new Error('kill switch engaged — new orders blocked at broker boundary (exits still allowed)');
  if (isCryptoSymbol(draft.symbol)) throw new Error(`crypto is permanently blocked (${draft.symbol})`);
  const ac = (draft.asset_class || 'equity').toLowerCase();
  const occ = (draft as any)._contract?.occSymbol as string | undefined;
  if (draft.side === 'sell') {
    // Contract-scoped for options (match the exact OCC), share-scoped otherwise.
    const heldRows = ac === 'option'
      ? await q<{ qty: number }>("SELECT COALESCE(SUM(qty),0) qty FROM positions WHERE env=:env AND asset_class='option' AND occ_symbol=:occ", { env, occ: occ || '' })
      : await q<{ qty: number }>("SELECT COALESCE(SUM(qty),0) qty FROM positions WHERE symbol=:s AND env=:env AND asset_class<>'option'", { s: draft.symbol, env });
    const heldQty = Number(heldRows[0]?.qty ?? 0);
    if (draft.qty > heldQty + 1e-9) throw new Error(`refusing to short: sell ${draft.qty} > held ${heldQty}`);
  }
  // ── OPTION placement (calls/puts) — use the contract resolved upstream (never re-resolve) ──
  if (ac === 'option') {
    if (!draft.option_type) throw new Error('option order missing option_type (call/put)');
    const c = (draft as any)._contract;
    if (!c?.occSymbol) throw new Error(`no resolved option contract for ${draft.symbol} — order NOT placed (fail-closed)`);
    // Require a REAL limit price — never silently downgrade to a market order on an
    // illiquid/wide option (unbounded slippage). mid (two-sided) → side quote → fail.
    const limit = draft.limit_price ?? c.mid ?? (draft.side === 'buy' ? c.ask : c.bid) ?? null;
    if (!(Number(limit) > 0)) throw new Error(`no two-sided quote for ${c.readable} — refusing to place an unpriced option order`);
    const posEffect: 'open' | 'close' = draft.side === 'buy' ? 'open' : 'close';

    if (brokerKind(env) === 'alpaca') {
      if (!alpacaConfigured()) throw new Error('Alpaca keys not configured');
      const raw = await alpacaFor(env).placeOption({ occSymbol: c.occSymbol, qty: draft.qty, side: draft.side, limit_price: limit });
      await audit('order.option.alpaca', `${draft.side} ${draft.qty}x ${c.readable} @ ${limit ?? 'mkt'}`, { occ: c.occSymbol });
      return { rhOrderId: raw?.id ? String(raw.id) : undefined, raw };
    }
    // Robinhood: resolve the option instrument UUID for this exact contract, then place.
    if (!rh.isConnected()) throw new Error('Robinhood MCP not connected (run npm run rh:auth)');
    const acctNum = await activeRhAccount();
    if (!acctNum) throw new Error('no Robinhood agentic account resolved for option order');
    // Prefer the RH instrument id resolved upstream (RH-native resolver); else look it up.
    const optionId = c.instrumentId || await rh.getOptionInstrumentId(draft.symbol, c.expiration, draft.option_type, c.strike);
    if (!optionId) throw new Error(`Robinhood has no tradable instrument for ${c.readable} — order NOT placed`);
    const raw = await rh.placeOptionOrder({ accountNumber: acctNum, optionId, side: draft.side, positionEffect: posEffect, quantity: draft.qty, price: limit });
    await audit('order.option.rh', `${draft.side} ${draft.qty}x ${c.readable} @ ${limit ?? 'mkt'}`, { optionId });
    const id = raw?.id || raw?.order_id || raw?.orderId;
    return { rhOrderId: id ? String(id) : undefined, raw };
  }

  if (brokerKind(env) === 'alpaca') {
    if (!alpacaConfigured()) throw new Error('Alpaca keys not configured');
    const raw = await alpacaFor(env).place(draft);
    return { rhOrderId: raw?.id ? String(raw.id) : undefined, raw };
  }
  // Robinhood MCP EQUITY placement.
  if (!rh.isConnected()) throw new Error('Robinhood MCP not connected (run npm run rh:auth)');
  const tool = rh
    .listToolsCached()
    .find((t) => isOrderWriteTool(t.name) && /place_equity|equity_order|buy|sell|place|create|submit/i.test(t.name) && !/cancel|option/i.test(t.name));
  if (!tool) throw new Error('No equity order-placement tool on Robinhood MCP');
  const acctNum = await activeRhAccount();
  // place_equity_order declares additionalProperties:false — extra keys (qty/order_type)
  // fail server-side validation, and prices are strings in the schema. ref_id is the
  // idempotency key the tool mandates so a transport retry can't double-place. (2026-08-24)
  const args: Record<string, any> = {
    account_number: acctNum, symbol: draft.symbol, side: draft.side, quantity: String(draft.qty),
    type: draft.order_type || 'market', time_in_force: 'gfd', ref_id: crypto.randomUUID(),
  };
  if (draft.limit_price != null) args.limit_price = String(draft.limit_price);
  if (draft.stop_price != null) args.stop_price = String(draft.stop_price);
  const raw = await rh.callTool(tool.name, args);
  const id = raw?.id || raw?.order_id || raw?.orderId;
  return { rhOrderId: id ? String(id) : undefined, raw };
}

export async function cancelAllLiveOrders(): Promise<void> {
  const env = await getTradingEnv();
  if (brokerKind(env) === 'alpaca' && alpacaConfigured()) await alpacaFor(env).cancelAll();
}

/** Extract the underlying ticker from an OCC option symbol (e.g. NVDA260116C00800000 → NVDA). */
export function underlyingFromOcc(occ: string): string {
  const m = /^([A-Z]+)\d{6}[CP]\d{8}$/.exec(occ);
  return m ? m[1] : occ;
}

/** Normalize broker-specific asset classes to our canonical equity|etf|option. */
function normalizeAssetClass(raw: any): string {
  const s = String(raw || 'equity').toLowerCase();
  if (s.includes('option')) return 'option';
  if (s.includes('etf')) return 'etf';
  return 'equity'; // us_equity, equity, stock, etc.
}

// ── Sync active broker → DB ──────────────────────────────────────────────────
function n(v: any): number | null {
  if (v == null) return null;
  const x = Number(v);
  return Number.isFinite(x) ? x : null;
}

export async function syncAll(): Promise<{ env: string; accounts: number; positions: number; orders: number }> {
  const env = await getTradingEnv();
  if (brokerKind(env) === 'robinhood') {
    const r = await rhSyncAll();
    return { env, ...r };
  }
  if (!alpacaConfigured()) return { env, accounts: 0, positions: 0, orders: 0 };
  const client = alpacaFor(env);
  let accounts = 0, positions = 0, orders = 0;
  try {
    const a = await client.account();
    const acctNum = String(a.account_number || env);
    await exec(
      `INSERT INTO accounts (account_number, env, type, buying_power, cash, equity, raw)
       VALUES (:an,:env,:t,:bp,:cash,:eq,CAST(:raw AS JSON))
       ON DUPLICATE KEY UPDATE env=:env, type=:t, buying_power=:bp, cash=:cash, equity=:eq, raw=CAST(:raw AS JSON)`,
      { an: acctNum, env, t: env, bp: n(a.buying_power), cash: n(a.cash), eq: n(a.equity || a.portfolio_value), raw: JSON.stringify(a) },
    );
    accounts = 1;

    const pos = await client.positions();
    // Replace the position set for this account snapshot.
    await exec('DELETE FROM positions WHERE account_number=:an', { an: acctNum });
    for (const p of pos || []) {
      const rawSym = String(p.symbol || '').toUpperCase();
      if (!rawSym) continue;
      const ac = isCryptoSymbol(rawSym) ? 'crypto' : normalizeAssetClass(p.asset_class);
      // For options Alpaca's `symbol` IS the OCC contract; split out the underlying
      // for display and key the row by the concrete OCC contract.
      const occ = ac === 'option' ? rawSym : '';
      const symbol = ac === 'option' ? underlyingFromOcc(rawSym) : rawSym;
      await exec(
        `INSERT INTO positions (account_number, env, symbol, occ_symbol, asset_class, qty, avg_cost, market_value, unrealized_pl, raw)
         VALUES (:an,:env,:s,:occ,:ac,:q,:avg,:mv,:upl,CAST(:raw AS JSON))`,
        { an: acctNum, env, s: symbol, occ, ac,
          q: n(p.qty), avg: n(p.avg_entry_price), mv: n(p.market_value), upl: n(p.unrealized_pl), raw: JSON.stringify(p) },
      );
      positions++;
    }

    const ords = await client.orders('all', 100);
    for (const o of ords || []) {
      if (!o.id) continue;
      await exec(
        `INSERT INTO orders (rh_order_id, env, symbol, side, qty, order_type, status, filled_qty, filled_price, source, raw)
         VALUES (:rid,:env,:s,:side,:q,:ot,:st,:fq,:fp,'manual',CAST(:raw AS JSON))
         ON DUPLICATE KEY UPDATE env=:env, status=:st, filled_qty=:fq, filled_price=:fp, raw=CAST(:raw AS JSON)`,
        { rid: String(o.id), env, s: String(o.symbol || '').toUpperCase(), side: o.side || 'buy', q: n(o.qty) ?? 0,
          ot: o.type || 'market', st: o.status || 'unknown', fq: n(o.filled_qty) ?? 0, fp: n(o.filled_avg_price), raw: JSON.stringify(o) },
      );
      orders++;
    }
  } catch (e: any) {
    await audit('sync.alpaca.error', e?.message || String(e));
  }
  return { env, accounts, positions, orders };
}

// ── Market data (always Alpaca; real bars for indicators) ───────────────────
export async function getBars(symbol: string, timeframe = '1Day', limit = 120): Promise<number[]> {
  if (!alpacaConfigured()) return [];
  try {
    const closes = await alpacaData.bars(symbol, timeframe, limit);
    return closes;
  } catch {
    return [];
  }
}

/** Fetch + cache bars into market_bars, return closes (oldest→newest). */
export async function refreshBars(symbol: string, timeframe = '1Day', limit = 120): Promise<number[]> {
  if (!alpacaConfigured()) return [];
  try {
    const raw = await alpacaData.barsRaw(symbol, timeframe, limit);
    for (const b of raw) {
      const ts = Date.parse(b.t);
      await exec(
        `INSERT INTO market_bars (symbol, timeframe, ts, o, h, l, c, v)
         VALUES (:s,:tf,:ts,:o,:h,:l,:c,:v)
         ON DUPLICATE KEY UPDATE o=:o,h=:h,l=:l,c=:c,v=:v`,
        { s: symbol.toUpperCase(), tf: timeframe, ts, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v ?? 0 },
      );
    }
    return raw.map((b: any) => Number(b.c)).filter((x: number) => Number.isFinite(x));
  } catch {
    return [];
  }
}
