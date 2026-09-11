import { q, exec, audit, getKillSwitch, getTradingEnv, setSetting } from './db.js';
import { isLiveEnv } from './config.js';
import { isObserveOnlyBot } from './risk/observe.js';
import { scanStrategies } from './backtest.js';
import { evaluateAllEnabledBots } from './bots/engine.js';
import { runLearning } from './learning.js';
import { decidePaperArm, MAC_DESK, type ArmDecision } from './paperArmDecide.js';

export { decidePaperArm, PAPER_ARM_MIN_TRADES, MAC_DESK } from './paperArmDecide.js';
export type { ScanRow, ArmAction, ArmDecision } from './paperArmDecide.js';

export type ArmOpts = { dryRun?: boolean; days?: number };

/**
 * Paper-only: scan every bot, enable winners in Auto, leave watch stubs as
 * observe-only, skip losers. Never flips TRADING_ENV to Robinhood live.
 */
export async function armPaperFromBacktests(opts: ArmOpts = {}): Promise<any> {
  const env = await getTradingEnv();
  if (env !== 'alpaca_paper' || isLiveEnv(env)) {
    throw new Error('refusing — arm-from-backtests is Alpaca paper only (never robinhood_live)');
  }
  if (await getKillSwitch()) {
    throw new Error('refusing — kill switch is on');
  }

  const days = Math.min(365, Math.max(30, Number(opts.days) || 182));
  const dryRun = !!opts.dryRun;
  const scan = await scanStrategies({ days });
  const bots = await q<any>('SELECT * FROM bots WHERE env=:env ORDER BY id ASC', { env });
  const byId = new Map<number, any>(bots.map((b: any) => [Number(b.id), b]));

  const decisions: ArmDecision[] = [];
  for (const row of scan.results || []) {
    const bot = byId.get(Number(row.bot_id));
    if (!bot) continue;
    decisions.push(decidePaperArm(row, isObserveOnlyBot(bot)));
  }

  const armed: ArmDecision[] = [];
  const watching: ArmDecision[] = [];
  const skipped: ArmDecision[] = [];

  for (const d of decisions) {
    if (d.action === 'trade') armed.push(d);
    else if (d.action === 'watch') watching.push(d);
    else skipped.push(d);
  }

  if (!dryRun) {
    for (const d of armed) {
      await exec("UPDATE bots SET enabled=1, mode='auto' WHERE id=:id AND env=:env", { id: d.bot_id, env });
    }
    for (const d of watching) {
      await exec("UPDATE bots SET enabled=1, mode='observe' WHERE id=:id AND env=:env", { id: d.bot_id, env });
    }
    await setSetting('global_mode', 'auto');
    await audit(
      'paper.arm_from_backtests',
      `armed ${armed.length} bot(s) for Alpaca paper Auto from ${days}d backtests; ${watching.length} watch stub(s); ${skipped.length} skipped`,
      { env, days, armed: armed.map((d) => d.bot_id), watching: watching.map((d) => d.bot_id) },
    );
  }

  let learning: any = null;
  if (!dryRun) {
    learning = await runLearning(env, { kind: 'daily', force: false }).catch((e: any) => ({
      skipped: true,
      reason: e?.message || String(e),
    }));
    try { await evaluateAllEnabledBots(); } catch (e: any) {
      learning = { ...(learning || {}), evaluate_error: e?.message || String(e) };
    }
  }

  return {
    ok: true,
    dry_run: dryRun,
    env,
    live: false,
    paper: true,
    global_mode: dryRun ? 'unchanged' : 'auto',
    days,
    desk: MAC_DESK,
    armed,
    watching,
    skipped,
    scan: { count: scan.count, winners_10x: scan.winners_10x, as_of: scan.as_of },
    learning,
    note: 'Alpaca paper only. Watch stubs cannot place orders. Nothing here switches to Robinhood live.',
  };
}
