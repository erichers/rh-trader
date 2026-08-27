import { q, exec, audit } from './db.js';
import { seedStrategies } from './bots/strategies.js';
import { seedQuickbots } from './quickbot.js';
import type { TradingEnv } from './config.js';

/**
 * FLEETS — bots belong to an ACCOUNT, not to the app. Every bot row carries `env`
 * (alpaca_paper | robinhood_live) and every read/write/eval is scoped to it, so
 * connecting a new account starts from zero: a fresh fleet, all DISABLED, with no
 * inherited picks, graduations, tuning or P/L. Orders, monitors, journal and
 * performance were already env-scoped, so the new account's history is empty too.
 *
 * Seeding is deliberately CHEAP: catalog defaults only. It must work with the market
 * closed and must not run minutes of backtests while the user waits on an account
 * switch. QuickBots are flagged `_needs_tuning` so the existing re-tune endpoint
 * (POST /api/quickbots/seed {force:true}) measures this account's own edge later.
 */

export async function botCount(env: TradingEnv): Promise<number> {
  const [row] = await q<{ n: number }>('SELECT COUNT(*) n FROM bots WHERE env=:env', { env });
  return Number(row?.n) || 0;
}

/** Seed the standard fleet (strategy library + QuickBots) for one account. Idempotent:
 *  anything already present for that env is left alone. Bots are created DISABLED. */
export async function seedFleet(env: TradingEnv, opts: { tuned?: boolean } = {}): Promise<any> {
  const strategies = await seedStrategies(env, { mode: 'cautious' });
  const quick = await seedQuickbots(env, { tuned: opts.tuned === true });
  const total = await botCount(env);
  return { env, strategies, quickbots: quick.seeded, bots: total, tuned: opts.tuned === true };
}

// One attempt per env per process — the worker safety net must not retry-loop on a
// seeding failure (that would spam the audit log every 30 seconds).
const attempted = new Set<string>();

/** Safety net: if the ACTIVE account has no bots at all, seed its fleet once. */
export async function ensureFleet(env: TradingEnv): Promise<any | null> {
  if (attempted.has(env)) return null;
  // An existing fleet counts as done UNLESS our own seed failed part-way (then the
  // name-idempotent seeders complete it next tick instead of leaving a partial fleet).
  if (!failed.has(env) && await botCount(env)) { attempted.add(env); return null; }
  if (seeding.has(env)) return null; // a seed is already in flight (env switch + worker net)
  seeding.add(env);
  try {
    const res = await seedFleet(env);
    failed.delete(env);
    attempted.add(env); // only a COMPLETED seed counts
    await audit('bots.fleet_seeded', `seeded a fresh bot fleet for ${env} (${res.bots} bots, all disabled)`, res);
    return res;
  } catch (e: any) {
    failed.add(env);
    await audit('bots.fleet_seed_error', `fleet seed for ${env} failed part-way, will retry: ${e?.message || e}`);
    throw e;
  } finally {
    seeding.delete(env);
  }
}
const seeding = new Set<TradingEnv>();
const failed = new Set<TradingEnv>();

/** Explicit reset: delete THIS account's bots and seed a fresh fleet. Only bots are
 *  removed — orders, position monitors, journal entries and the audit log are the
 *  permanent record of what actually happened and are never touched. */
export async function resetFleet(env: TradingEnv, opts: { forceOrphan?: boolean } = {}): Promise<any> {
  const before = await botCount(env);
  // Deleting bots that own trade history orphans attribution forever (perf/journal join
  // on bot_id, ids never reuse). Refuse unless the caller explicitly accepts that. (CP2 gate)
  const [h] = await q<{ orders: number; monitors: number }>(
    "SELECT (SELECT COUNT(*) FROM orders WHERE env=:env AND bot_id IS NOT NULL) orders, (SELECT COUNT(*) FROM position_monitors WHERE env=:env AND bot_id IS NOT NULL) monitors",
    { env },
  );
  if ((Number(h?.orders) || Number(h?.monitors)) && !opts.forceOrphan) {
    return { refused: true, reason: `this account has trade history attributed to its bots (${h.orders} orders, ${h.monitors} monitors); resetting would orphan that attribution. Send force_orphan:true to proceed.`, history: h };
  }
  if (seeding.has(env)) return { refused: true, reason: 'a fleet seed is already in flight for this account' };
  seeding.add(env);
  try {
    const del = await exec('DELETE FROM bots WHERE env=:env', { env });
    const res = await seedFleet(env);
    attempted.add(env);
    await audit('bots.fleet_reset', `reset the ${env} fleet: deleted ${del.affectedRows} bot(s), seeded ${res.bots}`, { before, deleted: del.affectedRows, ...res });
    return { ...res, deleted: del.affectedRows };
  } finally {
    seeding.delete(env);
  }
}
