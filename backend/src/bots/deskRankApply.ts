/**
 * Apply deskRank on Alpaca paper. Reads closed monitors, orders, and the
 * latest backtest row. Never runs on Robinhood live.
 */

import { audit, exec, q } from '../db.js';
import { isObserveOnlyBot } from '../risk/observe.js';
import { isLeapsTrade } from '../risk/dte.js';
import {
  actionAfterRank,
  rankDeskBot,
  riskAfterRank,
  type RankBacktest,
  type RankClose,
} from './deskRank.js';

function parse(v: any): any {
  if (v == null) return null;
  if (typeof v === 'object') return v;
  try { return JSON.parse(v); } catch { return null; }
}

export function refuseRankEnv(env: string): string | null {
  if (env !== 'alpaca_paper') return 'bot rank is Alpaca paper only';
  return null;
}

export async function applyPaperBotRanks(env: string): Promise<any> {
  const refused = refuseRankEnv(env);
  if (refused) return { ok: false, refused: true, env, summary: refused, changes: [] };
  const bots = await q<any>('SELECT * FROM bots WHERE env=:env ORDER BY id ASC', { env });
  const closes = await q<any>(
    `SELECT bot_id, entry_price, exit_price, last_price, reason
       FROM position_monitors
      WHERE status='closed' AND bot_id IS NOT NULL
        AND (env=:env OR (env IS NULL AND :env='alpaca_paper'))
      ORDER BY id DESC LIMIT 2000`,
    { env },
  );
  const orders = await q<{ bot_id: number; status: string; n: number }>(
    `SELECT bot_id, status, COUNT(*) n FROM orders
      WHERE env=:env AND bot_id IS NOT NULL
      GROUP BY bot_id, status`,
    { env },
  ).catch(() => []);
  const backs = await q<{ bot_id: number; metrics: any }>(
    `SELECT b.bot_id, b.metrics FROM backtests b
      INNER JOIN (SELECT bot_id, MAX(id) id FROM backtests GROUP BY bot_id) t ON t.id=b.id`,
  ).catch(() => []);

  const byBot = new Map<number, RankClose[]>();
  for (const row of closes || []) {
    const id = Number(row.bot_id);
    if (!id) continue;
    const list = byBot.get(id) || [];
    list.push({
      entry_price: row.entry_price,
      exit_price: row.exit_price,
      last_price: row.last_price,
      reason: row.reason,
    });
    byBot.set(id, list);
  }
  const btBy = new Map<number, RankBacktest>();
  for (const row of backs || []) {
    const m = parse(row.metrics) || {};
    btBy.set(Number(row.bot_id), {
      num_trades: m.num_trades,
      total_return_pct: m.total_return_pct,
      modeled: m.modeled,
      error: m.error,
    });
  }
  const filled = new Map<number, number>();
  for (const row of orders || []) {
    if (row.status === 'filled' || row.status === 'partially_filled') {
      filled.set(Number(row.bot_id), (filled.get(Number(row.bot_id)) || 0) + Number(row.n));
    }
  }

  const changes: any[] = [];
  for (const bot of bots || []) {
    const action = parse(bot.action) || {};
    const decision = rankDeskBot(
      {
        id: bot.id,
        name: bot.name,
        mode: bot.mode,
        enabled: bot.enabled,
        asset_class: bot.asset_class,
        action,
        risk: parse(bot.risk),
        observeOnly: isObserveOnlyBot(bot),
        leaps: isLeapsTrade({ name: bot.name, expiration: action.expiration, key: action._strategy }),
      },
      byBot.get(Number(bot.id)) || [],
      btBy.get(Number(bot.id)) || null,
    );
    if (decision.action === 'hold') continue;
    const risk = riskAfterRank(bot.risk, decision);
    const nextAction = actionAfterRank(bot.action, decision);
    const mode = decision.mode || bot.mode;
    const enabled = decision.enabled != null ? decision.enabled : (bot.enabled ? 1 : 0);
    await exec(
      `UPDATE bots SET mode=:mode, enabled=:enabled, risk=CAST(:risk AS JSON), action=CAST(:action AS JSON)
        WHERE id=:id AND env=:env`,
      {
        mode,
        enabled,
        risk: JSON.stringify(risk || parse(bot.risk) || {}),
        action: JSON.stringify(nextAction || action),
        id: bot.id,
        env,
      },
    );
    const fills = filled.get(Number(bot.id)) || 0;
    changes.push({ ...decision, filledOrders: fills });
  }
  if (changes.length) {
    await audit('bots.desk_rank', `paper rank changed ${changes.length} bot(s)`, { changes });
  }
  return { ok: true, env, changes, summary: changes.length ? `ranked ${changes.length}` : 'no rank changes' };
}
