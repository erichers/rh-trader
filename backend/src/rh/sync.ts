import { exec, audit, getSetting } from '../db.js';
import { rh, asRows } from './mcpClient.js';
import { buildOcc } from '../brokers/options.js';
import { isCryptoSymbol } from '../config.js';

// The Robinhood MCP is always the live agentic (real-money) environment.
const RH_ENV = 'robinhood_live';

function pick(o: any, keys: string[], d: any = null): any {
  for (const k of keys) if (o && o[k] != null) return o[k];
  return d;
}

/**
 * Choose which Robinhood account the dashboard tracks. The MCP exposes several
 * (individual, IRAs, the cash "options" account). Precedence:
 *   1. an explicit `rh_account_number` setting (user override),
 *   2. an account flagged agentic_allowed,
 *   3. the default account,
 *   4. the first account.
 * Returns { account_number, account } or null when none are connected.
 */
export async function activeRhAccountNumber(): Promise<string | null> {
  const sel = await chooseAccount();
  return sel?.account_number || null;
}

async function chooseAccount(): Promise<{ account_number: string; account: any } | null> {
  const accounts = asRows(await rh.getAccounts());
  if (!accounts.length) return null;
  const override = await getSetting<string>('rh_account_number', '');
  const num = (a: any) => String(pick(a, ['account_number', 'account', 'rhs_account_number', 'id'], ''));
  let chosen =
    (override && accounts.find((a) => num(a) === override)) ||
    accounts.find((a) => a.agentic_allowed === true) ||
    accounts.find((a) => a.is_default === true) ||
    accounts[0];
  return { account_number: num(chosen), account: chosen };
}

export async function syncAccounts(): Promise<number> {
  if (!rh.isConnected()) return 0;
  const sel = await chooseAccount();
  if (!sel) return 0;
  // Balances/equity come from get_portfolio (the accounts list carries no money).
  // The payload is nested under `data`, and buying_power is itself an object.
  const portfolio = await rh.getPortfolio(sel.account_number).catch(() => null);
  const p = ((portfolio?.data ?? asRows(portfolio)[0] ?? portfolio) ?? {}) as any;
  const bpRaw = p.buying_power;
  const bp = bpRaw && typeof bpRaw === 'object'
    ? numOrNull(pick(bpRaw, ['buying_power', 'unleveraged_buying_power']))
    : numOrNull(bpRaw);
  await exec(
    `INSERT INTO accounts (account_number, env, type, buying_power, cash, equity, raw)
     VALUES (:account_number,:env,:type,:bp,:cash,:equity,CAST(:raw AS JSON))
     ON DUPLICATE KEY UPDATE env=:env, type=:type, buying_power=:bp, cash=:cash, equity=:equity, raw=CAST(:raw AS JSON)`,
    {
      account_number: sel.account_number || 'agentic',
      env: RH_ENV,
      type: pick(sel.account, ['nickname', 'brokerage_account_type', 'type', 'account_type'], 'agentic'),
      bp,
      cash: numOrNull(pick(p, ['cash', 'cash_balance', 'uninvested_cash'])),
      equity: numOrNull(pick(p, ['total_value', 'equity', 'total_equity', 'market_value', 'portfolio_value'])),
      raw: JSON.stringify({ account: sel.account, portfolio: portfolio?.data ?? portfolio }),
    },
  );
  return 1;
}

export async function syncPositions(): Promise<number> {
  if (!rh.isConnected()) return 0;
  const sel = await chooseAccount();
  if (!sel) return 0;
  const rows = await rh.getPositions(sel.account_number);
  // Replace this account's position set so closed positions disappear.
  await exec('DELETE FROM positions WHERE env=:env AND account_number=:acct', { env: RH_ENV, acct: sel.account_number || 'agentic' });
  let n = 0;
  for (const p of rows) {
    const symbol = String(pick(p, ['symbol', 'ticker', 'instrument_symbol', 'chain_symbol', 'underlying_symbol'], '')).toUpperCase();
    if (!symbol) continue;
    const ac = isCryptoSymbol(symbol) ? 'crypto' : (p.__asset_class || pick(p, ['asset_class', 'type'], 'equity'));
    // Key option rows by their concrete contract so distinct strikes/expirations
    // (and equity vs options on the same underlying) don't collide on the unique key.
    // Build the canonical OCC from the contract fields — RH publishes no OCC field, and a
    // UUID/underlying stored here makes every stop-loss fail the long-only gate with held=0
    // (the exit matches positions on the exact occ_symbol). Fallback: legacy pick. (2026-08-24)
    let occ = '';
    if (ac === 'option') {
      const exp = String(pick(p, ['expiration_date', 'expiration', 'exp_date'], ''));
      const strike = Number(pick(p, ['strike_price', 'strike'], NaN));
      const otype = String(pick(p, ['option_type', 'contract_type'], '')).toLowerCase();
      const under = String(pick(p, ['chain_symbol', 'underlying_symbol'], symbol)).toUpperCase();
      occ = /^\d{4}-\d{2}-\d{2}$/.test(exp) && strike > 0 && (otype === 'call' || otype === 'put') && /^[A-Z][A-Z.]{0,5}$/.test(under)
        ? buildOcc(under, exp, otype as 'call' | 'put', strike)
        : String(pick(p, ['occ_symbol', 'option_symbol', 'symbol', 'instrument_id', 'id', 'chain_id'], '')).toUpperCase();
    }
    await exec(
      `INSERT INTO positions (account_number, env, symbol, occ_symbol, asset_class, qty, avg_cost, market_value, unrealized_pl, raw)
       VALUES (:acct,:env,:symbol,:occ,:ac,:qty,:avg,:mv,:upl,CAST(:raw AS JSON))
       ON DUPLICATE KEY UPDATE qty=:qty, avg_cost=:avg, market_value=:mv, unrealized_pl=:upl, raw=CAST(:raw AS JSON)`,
      {
        acct: sel.account_number || 'agentic',
        env: RH_ENV,
        symbol,
        occ,
        ac,
        qty: numOrNull(pick(p, ['quantity', 'qty', 'shares'])),
        avg: numOrNull(pick(p, ['average_buy_price', 'avg_cost', 'average_price', 'cost_basis', 'average_open_price'])),
        mv: numOrNull(pick(p, ['market_value', 'value', 'equity'])),
        upl: numOrNull(pick(p, ['unrealized_pl', 'unrealized_pnl', 'total_return', 'gain_loss'])),
        raw: JSON.stringify(p),
      },
    );
    n++;
  }
  return n;
}

export async function syncOrders(): Promise<number> {
  if (!rh.isConnected()) return 0;
  const sel = await chooseAccount();
  if (!sel) return 0;
  const rows = await rh.getOrders(sel.account_number);
  let n = 0;
  for (const o of rows) {
    const rid = pick(o, ['id', 'order_id', 'orderId']);
    if (!rid) continue;
    const symbol = String(pick(o, ['symbol', 'ticker', 'chain_symbol', 'underlying_symbol'], '')).toUpperCase();
    await exec(
      `INSERT INTO orders (rh_order_id, env, symbol, asset_class, side, qty, order_type, status, filled_qty, filled_price, source, raw)
       VALUES (:rid,:env,:symbol,:ac,:side,:qty,:otype,:status,:fqty,:fprice,'manual',CAST(:raw AS JSON))
       ON DUPLICATE KEY UPDATE env=:env, status=:status, filled_qty=:fqty, filled_price=:fprice, raw=CAST(:raw AS JSON)`,
      {
        rid: String(rid),
        env: RH_ENV,
        symbol,
        ac: o.__asset_class || 'equity',
        side: pick(o, ['side', 'direction'], 'buy'),
        qty: numOrNull(pick(o, ['quantity', 'qty'])) ?? 0,
        otype: pick(o, ['type', 'order_type'], 'market'),
        status: pick(o, ['state', 'status'], 'unknown'),
        fqty: numOrNull(pick(o, ['filled_quantity', 'cumulative_quantity'])) ?? 0,
        fprice: numOrNull(pick(o, ['average_price', 'filled_price', 'price'])),
        raw: JSON.stringify(o),
      },
    );
    n++;
  }
  return n;
}

export async function syncAll(): Promise<{ accounts: number; positions: number; orders: number }> {
  const out = { accounts: 0, positions: 0, orders: 0 };
  try {
    out.accounts = await syncAccounts();
    out.positions = await syncPositions();
    out.orders = await syncOrders();
  } catch (e: any) {
    await audit('sync.error', e?.message || String(e));
  }
  return out;
}

function numOrNull(v: any): number | null {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
