/**
 * Desk list + reattach queries, and the off-hours monitor pass.
 * Kept pure so tests can lock the SQL that the live Mac desk depends on.
 */

/** Open stops first. `ORDER BY status ASC` sorts `closed` before `open`, so LIMIT 100 hid live stops. */
export const MONITORS_LIST_SQL =
  "SELECT * FROM position_monitors WHERE env=:env OR (env IS NULL AND :env='alpaca_paper') ORDER BY (status='open') DESC, opened_at DESC LIMIT 200";

/** Reattach/backfill buys. Filled and partially_filled only — never vetoed, canceled, rejected, or unfilled drafts. */
export const BOT_MATCH_BUY_SQL =
  `SELECT o.id, o.bot_id, o.symbol, o.side, o.status, o.raw, b.name AS bot_name
     FROM orders o
     LEFT JOIN bots b ON b.id=o.bot_id
    WHERE (o.env=:env OR (o.env IS NULL AND :env='alpaca_paper'))
      AND o.side='buy' AND o.bot_id IS NOT NULL
      AND o.status IN ('filled','partially_filled')
      AND o.created_at >= DATE_SUB(NOW(), INTERVAL 21 DAY)
    ORDER BY o.id DESC LIMIT 400`;

export const BOT_MATCH_SIGNAL_SQL =
  `SELECT s.bot_id, s.symbol, s.fired, b.name AS bot_name
     FROM signals s
     LEFT JOIN bots b ON b.id=s.bot_id
    WHERE s.fired=1 AND s.bot_id IS NOT NULL
      AND s.created_at >= DATE_SUB(NOW(), INTERVAL 7 DAY)
    ORDER BY s.id DESC LIMIT 400`;

/**
 * Market-closed monitor pass.
 * Any open monitor still gets stop / trail / gain-lock (after-hours Mag-7 gaps).
 * `reconcileOnly` skips that ladder, so it is only for an empty book.
 */
export function closedMarketMonitorOpts(openMonitorCount: number): { reconcileOnly: boolean } {
  return { reconcileOnly: !(Number(openMonitorCount) > 0) };
}
