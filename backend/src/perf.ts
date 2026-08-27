import { q, getTradingEnv } from './db.js';
import type { TradingEnv } from './config.js';

/** Per-bot LIVE performance attribution from REAL account activity (env-scoped):
 *  - order counts by status (placed/filled/staged/vetoed/...)
 *  - realized P/L from CLOSED monitors (option premium or share move: (exit−entry)/entry)
 *  - open/unrealized P/L from OPEN monitors (live last vs entry)
 *  Everything traces to real orders + monitor rows — nothing modeled. */
export async function botPerformance(envArg?: TradingEnv): Promise<any> {
  const env = envArg ?? (await getTradingEnv());
  const bots = await q<any>('SELECT id, name, enabled, mode, asset_class FROM bots WHERE env=:env ORDER BY id', { env });
  const orders = await q<{ bot_id: number; status: string; n: number }>(
    "SELECT bot_id, status, COUNT(*) n FROM orders WHERE bot_id IS NOT NULL AND env=:env GROUP BY bot_id, status", { env },
  );
  const mons = await q<{ bot_id: number; status: string; entry_price: number; last_price: number; exit_price: number | null; reason: string }>(
    'SELECT bot_id, status, entry_price, last_price, exit_price, reason FROM position_monitors WHERE bot_id IS NOT NULL AND env=:env', { env },
  );

  const byBot: Record<number, any> = {};
  for (const b of bots) byBot[b.id] = {
    id: b.id, name: b.name, enabled: !!b.enabled, mode: b.mode, asset_class: b.asset_class,
    orders: { placed: 0, filled: 0, staged: 0, vetoed: 0, rejected: 0, canceled: 0, draft: 0, total: 0 },
    closed_trades: 0, wins: 0, realized_pl_pct: 0, win_rate: 0, avg_trade_pct: 0,
    open_positions: 0, open_pl_pct: 0, best_pct: null as number | null, worst_pct: null as number | null,
  };
  for (const o of orders) { const r = byBot[o.bot_id]; if (!r) continue; const n = Number(o.n); if (o.status !== 'total') r.orders[o.status] = (r.orders[o.status] || 0) + n; r.orders.total += n; }

  const realized: Record<number, number[]> = {};
  const open: Record<number, number[]> = {};
  for (const m of mons) {
    const r = byBot[m.bot_id]; if (!r) continue;
    const entry = Number(m.entry_price);
    // Closed trades realize at the recorded exit FILL when present, else the last/trigger price.
    const last = (m.status === 'closed' && Number(m.exit_price) > 0) ? Number(m.exit_price) : Number(m.last_price);
    if (!(entry > 0) || !Number.isFinite(last)) continue;
    const ret = ((last - entry) / entry) * 100;
    if (m.status === 'closed') (realized[m.bot_id] ||= []).push(ret);
    else if (m.status === 'open') (open[m.bot_id] ||= []).push(ret);
  }
  for (const id of Object.keys(byBot).map(Number)) {
    const rl = realized[id] || []; const op = open[id] || [];
    const r = byBot[id];
    r.closed_trades = rl.length;
    r.wins = rl.filter((x) => x > 0).length;
    r.win_rate = rl.length ? Math.round((r.wins / rl.length) * 1000) / 10 : 0;
    r.realized_pl_pct = Math.round(rl.reduce((s, x) => s + x, 0) * 10) / 10;     // sum of per-trade %
    r.avg_trade_pct = rl.length ? Math.round((r.realized_pl_pct / rl.length) * 10) / 10 : 0;
    r.best_pct = rl.length ? Math.round(Math.max(...rl) * 10) / 10 : null;
    r.worst_pct = rl.length ? Math.round(Math.min(...rl) * 10) / 10 : null;
    r.open_positions = op.length;
    r.open_pl_pct = op.length ? Math.round((op.reduce((s, x) => s + x, 0) / op.length) * 10) / 10 : 0;
  }

  const rows = Object.values(byBot);
  const active = rows.filter((r: any) => r.orders.total > 0 || r.closed_trades > 0 || r.open_positions > 0 || r.enabled);
  return {
    env,
    summary: {
      bots: rows.length,
      active: active.length,
      closed_trades: rows.reduce((s: number, r: any) => s + r.closed_trades, 0),
      open_positions: rows.reduce((s: number, r: any) => s + r.open_positions, 0),
      orders_total: rows.reduce((s: number, r: any) => s + r.orders.total, 0),
    },
    bots: rows,
  };
}
