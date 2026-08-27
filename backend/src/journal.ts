import { q, exec, getTradingEnv } from './db.js';
import type { TradingEnv } from './config.js';

// Trade journal — auto-populated from REAL round-trips (closed position_monitors carry the
// entry, the actual exit fill, the exit reason, and timestamps). User tags + notes + a
// "reviewed" flag live in a thin journal_meta table keyed by monitor id, so the journal is
// ALWAYS in sync with real fills (no duplicated trade data that could drift). Nothing modeled.

export type JournalQuery = { status?: 'closed' | 'open' | 'all'; bot_id?: number; tag?: string; limit?: number };

function r2(n: number, d = 2): number { const f = 10 ** d; return Number.isFinite(n) ? Math.round(n * f) / f : 0; }

/** A round-trip's realized (or open) P/L from real prices: prefer the recorded exit fill, else
 *  the last monitored price. Options are ×100 (contract multiplier); shares ×1. */
function plOf(m: any): { pct: number; usd: number; exit: number } {
  const entry = Number(m.entry_price) || 0;
  const exit = Number(m.exit_price) || Number(m.last_price) || 0;
  const qty = Number(m.qty) || 0;
  const mult = (m.asset_class || '').toLowerCase() === 'option' ? 100 : 1;
  const pct = entry > 0 ? ((exit - entry) / entry) * 100 : 0;
  const usd = (exit - entry) * qty * mult;
  return { pct: r2(pct, 2), usd: r2(usd, 2), exit: r2(exit, 4) };
}

export async function tradeJournal(envArg?: TradingEnv, query: JournalQuery = {}): Promise<any> {
  const env = envArg ?? (await getTradingEnv());
  const status = query.status || 'closed';
  const lim = Math.min(500, Math.max(1, Number(query.limit) || 200));
  const where: string[] = ['(m.env=:env OR (m.env IS NULL AND :env=\'alpaca_paper\'))'];
  const params: any = { env, lim };
  if (status !== 'all') { where.push('m.status=:st'); params.st = status; }
  if (query.bot_id) { where.push('m.bot_id=:bid'); params.bid = Number(query.bot_id); }
  const rows = await q<any>(
    `SELECT m.*, b.name AS bot_name, jm.tags AS jtags, jm.note AS jnote, jm.reviewed AS jreviewed
     FROM position_monitors m
     LEFT JOIN bots b ON b.id=m.bot_id
     LEFT JOIN journal_meta jm ON jm.monitor_id=m.id
     WHERE ${where.join(' AND ')}
     ORDER BY (m.closed_at IS NULL) DESC, m.closed_at DESC, m.opened_at DESC
     LIMIT :lim`, params,
  );

  const trades = rows.map((m: any) => {
    const pl = plOf(m);
    const held = m.opened_at && m.closed_at ? Math.max(0, (Date.parse(m.closed_at) - Date.parse(m.opened_at)) / 864e5) : null;
    const tags: string[] = parseTags(m.jtags);
    return {
      id: m.id, env: m.env, status: m.status, symbol: m.symbol, occ_symbol: m.occ_symbol || null,
      asset_class: m.asset_class, bot_id: m.bot_id, bot_name: m.bot_name || (m.bot_id ? `bot #${m.bot_id}` : 'AI/manual'),
      qty: Number(m.qty), entry_price: r2(Number(m.entry_price), 4), exit_price: m.exit_price != null ? r2(Number(m.exit_price), 4) : null,
      last_price: r2(Number(m.last_price), 4), exit_used: pl.exit, exit_is_fill: !!m.exit_is_fill,
      reason: m.reason || null, pnl_pct: pl.pct, pnl_usd: pl.usd,
      opened_at: m.opened_at, closed_at: m.closed_at, hold_days: held != null ? r2(held, 2) : null,
      tags, note: m.jnote || '', reviewed: !!m.jreviewed,
    };
  }).filter((t: any) => !query.tag || t.tags.includes(query.tag));

  // Summary over CLOSED trades only (open trades are unrealized).
  const closed = trades.filter((t: any) => t.status === 'closed');
  const wins = closed.filter((t: any) => t.pnl_pct > 0);
  const sum = (a: any[], f: (t: any) => number) => a.reduce((s, t) => s + f(t), 0);
  const byKey = (a: any[], keyer: (t: any) => string) => {
    const g: Record<string, { key: string; n: number; pnl_usd: number; wins: number }> = {};
    for (const t of a) { const k = keyer(t); (g[k] ||= { key: k, n: 0, pnl_usd: 0, wins: 0 }); g[k].n++; g[k].pnl_usd += t.pnl_usd; if (t.pnl_pct > 0) g[k].wins++; }
    return Object.values(g).map((x) => ({ ...x, pnl_usd: r2(x.pnl_usd), win_rate: x.n ? r2((x.wins / x.n) * 100, 1) : 0 })).sort((a, b) => b.pnl_usd - a.pnl_usd);
  };
  const tagCounts: Record<string, number> = {};
  for (const t of trades) for (const tag of t.tags) tagCounts[tag] = (tagCounts[tag] || 0) + 1;

  return {
    env,
    summary: {
      closed_trades: closed.length, open_trades: trades.filter((t: any) => t.status === 'open').length,
      wins: wins.length, win_rate: closed.length ? r2((wins.length / closed.length) * 100, 1) : 0,
      total_pnl_usd: r2(sum(closed, (t) => t.pnl_usd)), total_pnl_pct: r2(sum(closed, (t) => t.pnl_pct), 1),
      avg_pnl_pct: closed.length ? r2(sum(closed, (t) => t.pnl_pct) / closed.length, 2) : 0,
      best_pct: closed.length ? r2(Math.max(...closed.map((t: any) => t.pnl_pct)), 1) : null,
      worst_pct: closed.length ? r2(Math.min(...closed.map((t: any) => t.pnl_pct)), 1) : null,
      reviewed: closed.filter((t: any) => t.reviewed).length,
    },
    by_bot: byKey(closed, (t) => t.bot_name),
    by_reason: byKey(closed, (t) => t.reason || 'open'),
    tags: Object.entries(tagCounts).map(([tag, n]) => ({ tag, n })).sort((a, b) => b.n - a.n),
    trades,
    note: 'Each row is a real round-trip from the position monitor: entry fill → exit fill (or last price if the broker didn’t report a fill). P/L is computed from those real prices. Tags & notes are yours; they don’t affect trading.',
  };
}

/** Upsert the user's tags / note / reviewed flag for one journal entry (by monitor id). */
export async function setJournalMeta(monitorId: number, patch: { tags?: string[]; note?: string; reviewed?: boolean }): Promise<any> {
  const [exists] = await q<{ n: number }>('SELECT COUNT(*) n FROM position_monitors WHERE id=:id', { id: monitorId });
  if (!Number(exists?.n)) throw new Error('trade not found');
  const cur = (await q<any>('SELECT * FROM journal_meta WHERE monitor_id=:id', { id: monitorId }))[0] || {};
  const tags = patch.tags !== undefined ? patch.tags.map((t) => String(t).trim().toLowerCase()).filter(Boolean).slice(0, 12) : parseTags(cur.tags);
  const note = patch.note !== undefined ? String(patch.note).slice(0, 2000) : (cur.note || '');
  const reviewed = patch.reviewed !== undefined ? (patch.reviewed ? 1 : 0) : (cur.reviewed ? 1 : 0);
  await exec(
    `INSERT INTO journal_meta (monitor_id, tags, note, reviewed) VALUES (:id, CAST(:tags AS JSON), :note, :rev)
     ON DUPLICATE KEY UPDATE tags=CAST(:tags AS JSON), note=:note, reviewed=:rev`,
    { id: monitorId, tags: JSON.stringify(tags), note, rev: reviewed },
  );
  return { ok: true, monitor_id: monitorId, tags, note, reviewed: !!reviewed };
}

function parseTags(v: any): string[] {
  if (!v) return [];
  try { const a = typeof v === 'string' ? JSON.parse(v) : v; return Array.isArray(a) ? a.map((s) => String(s)) : []; } catch { return []; }
}
