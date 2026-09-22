/**
 * Insert missing Fox wait-for-signal rows for an Alpaca paper fleet.
 * Idempotent by name. Retires the earlier boom packs. Never writes on Robinhood live.
 */

import { exec, q } from '../db.js';
import { RETIRED_BOOM_NAMES, aiBoomInserts } from './aiBoom.js';

export async function ensureAiBoomPacks(env: string): Promise<{
  env: string;
  created: string[];
  skipped: string[];
  retired: string[];
  refused?: string;
}> {
  if (env !== 'alpaca_paper') {
    return { env, created: [], skipped: [], retired: [], refused: 'Fox wait-for-signal bots are Alpaca paper only' };
  }
  const retired = await retireOldBoomPacks(env);
  const created: string[] = [];
  const skipped: string[] = [];
  for (const row of aiBoomInserts()) {
    const existing = await q<{ id: number }>('SELECT id FROM bots WHERE env=:env AND name=:n LIMIT 1', { env, n: row.name });
    if (existing.length) {
      skipped.push(row.name);
      continue;
    }
    await exec(
      `INSERT INTO bots (name, env, enabled, symbols, asset_class, rules, ai_gate, action, risk, mode)
       VALUES (:name,:env,0,CAST(:symbols AS JSON),'option',CAST(:rules AS JSON),CAST(:ai AS JSON),CAST(:action AS JSON),CAST(:risk AS JSON),:mode)`,
      {
        name: row.name,
        env,
        mode: row.mode,
        symbols: JSON.stringify(row.symbols),
        rules: JSON.stringify(row.rules),
        ai: JSON.stringify({ enabled: false }),
        action: JSON.stringify(row.action),
        risk: JSON.stringify(row.risk),
      },
    );
    created.push(row.name);
  }
  return { env, created, skipped, retired };
}

/** Drop an unused old pack. If it already has an order row, leave it disabled in observe. */
async function retireOldBoomPacks(env: string): Promise<string[]> {
  const retired: string[] = [];
  for (const name of RETIRED_BOOM_NAMES) {
    const rows = await q<{ id: number }>('SELECT id FROM bots WHERE env=:env AND name=:n LIMIT 1', { env, n: name });
    if (!rows.length) continue;
    const id = rows[0].id;
    const orders = await q<{ id: number }>('SELECT id FROM orders WHERE bot_id=:id LIMIT 1', { id });
    if (orders.length) {
      await exec(
        `UPDATE bots
            SET enabled=0,
                mode='observe',
                action=JSON_SET(COALESCE(action, JSON_OBJECT()), '$._retired', true, '$._full_auto_ok', false),
                risk=JSON_SET(COALESCE(risk, JSON_OBJECT()), '$._retired', true)
          WHERE id=:id AND env=:env`,
        { id, env },
      );
    } else {
      await exec('DELETE FROM bots WHERE id=:id AND env=:env', { id, env });
    }
    retired.push(name);
  }
  return retired;
}
