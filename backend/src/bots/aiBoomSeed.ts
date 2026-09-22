/**
 * Insert missing AI boom rows for an Alpaca paper fleet.
 * Idempotent by name. Never writes on Robinhood live.
 */

import { exec, q } from '../db.js';
import { aiBoomInserts } from './aiBoom.js';

export async function ensureAiBoomPacks(env: string): Promise<{ env: string; created: string[]; skipped: string[]; refused?: string }> {
  if (env !== 'alpaca_paper') {
    return { env, created: [], skipped: [], refused: 'AI boom packs are Alpaca paper only' };
  }
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
  return { env, created, skipped };
}
