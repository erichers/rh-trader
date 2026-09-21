/**
 * Muse improve — local heuristic performance edits on paper bots.
 * Never places, never widens live stops, never flips Robinhood live, never outbound.
 */

import { audit, exec, getTradingEnv, q } from '../db.js';
import { isLiveEnv } from '../config.js';
import { parseJsonish } from '../risk/observe.js';
import {
  HARD_STOP_PCT,
  SOFT_TAKE_PROFIT_PCT,
  SWING_TRAIL_PCT,
} from '../risk/exitpolicy.js';
import { isObserveOnlyBot } from '../risk/observe.js';

export const MUSE_TRAIL_MIN = 8;
export const MUSE_TRAIL_MAX = 15;

export type MuseImproveChange = { field: string; from: unknown; to: unknown };

export type MuseImproveProposal = {
  id: number | null;
  name: string;
  reason: string;
  changes: MuseImproveChange[];
  next: { risk: Record<string, any>; rules: Record<string, any> };
};

export type MuseLastTune = {
  at: string;
  botId: number | null;
  name: string;
  missingBot?: boolean;
  symbol?: string | null;
  because?: string | null;
};

let lastTune: MuseLastTune | null = null;

export function museLastTune(): MuseLastTune | null {
  return lastTune;
}

/** Honest lamp text. A null bot is not a bot name. */
export function formatMuseTune(tune: MuseLastTune | null | undefined): string {
  if (!tune) return '';
  if (tune.botId == null || tune.missingBot) return 'last tune: bot missing';
  return `last tune ${tune.name || `bot #${tune.botId}`}`;
}

export function resetMuseImproveForTests(): void {
  lastTune = null;
}

function clone<T>(v: T): T {
  return v == null ? v : JSON.parse(JSON.stringify(v));
}

function eq(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function noisyLastResult(lr: unknown): { skips: number; fires: number } {
  const rows = Array.isArray(lr) ? lr : (lr && typeof lr === 'object' ? [lr] : []);
  let skips = 0;
  let fires = 0;
  for (const r of rows) {
    if (!r || typeof r !== 'object') continue;
    if ((r as any).skipped || (r as any).error) skips++;
    if ((r as any).fired || (r as any).status === 'execute') fires++;
  }
  return { skips, fires };
}

/** Pure. Safe clamps only. Null when already compliant. */
export function proposeMuseImprove(bot: any): MuseImproveProposal | null {
  if (isObserveOnlyBot(bot)) return null;
  const risk = clone(parseJsonish(bot?.risk) ?? bot?.risk ?? {}) || {};
  const rules = clone(parseJsonish(bot?.rules) ?? bot?.rules ?? {}) || {};
  const origRisk = clone(risk);
  const origRules = clone(rules);
  const changes: MuseImproveChange[] = [];

  const sl = Number(risk.stop_loss_pct);
  if (Number.isFinite(sl) && sl > HARD_STOP_PCT) {
    risk.stop_loss_pct = HARD_STOP_PCT;
    changes.push({ field: 'stop_loss_pct', from: sl, to: HARD_STOP_PCT });
  } else if (!Number.isFinite(sl) || !(sl > 0)) {
    risk.stop_loss_pct = HARD_STOP_PCT;
    if (origRisk.stop_loss_pct !== HARD_STOP_PCT) {
      changes.push({ field: 'stop_loss_pct', from: origRisk.stop_loss_pct ?? null, to: HARD_STOP_PCT });
    }
  }

  const tp = Number(risk.take_profit_pct);
  if (!Number.isFinite(tp) || tp <= 0 || tp > 30) {
    risk.take_profit_pct = SOFT_TAKE_PROFIT_PCT;
    if (origRisk.take_profit_pct !== SOFT_TAKE_PROFIT_PCT) {
      changes.push({ field: 'take_profit_pct', from: origRisk.take_profit_pct ?? null, to: SOFT_TAKE_PROFIT_PCT });
    }
  }

  const trail = Number(risk.trailing_stop_pct);
  if (!Number.isFinite(trail) || trail < MUSE_TRAIL_MIN || trail > MUSE_TRAIL_MAX) {
    risk.trailing_stop_pct = SWING_TRAIL_PCT;
    if (origRisk.trailing_stop_pct !== SWING_TRAIL_PCT) {
      changes.push({ field: 'trailing_stop_pct', from: origRisk.trailing_stop_pct ?? null, to: SWING_TRAIL_PCT });
    }
  }

  const noise = noisyLastResult(parseJsonish(bot?.last_result) ?? bot?.last_result);
  const min = Number(rules.min_matches);
  if (noise.skips >= 3 && (!Number.isFinite(min) || min < 2)) {
    const from = Number.isFinite(min) ? min : null;
    rules.min_matches = 2;
    changes.push({ field: 'min_matches', from, to: 2 });
  }
  const cd = Number(rules.cooldown_min ?? rules.cooldown);
  if (noise.fires >= 2 && (!Number.isFinite(cd) || cd < 15)) {
    rules.cooldown_min = 30;
    changes.push({ field: 'cooldown_min', from: cd || null, to: 30 });
  }

  if (!changes.length || (eq(origRisk, risk) && eq(origRules, rules))) return null;
  return {
    id: bot?.id != null ? Number(bot.id) : null,
    name: String(bot?.name || `bot #${bot?.id ?? '?'}`),
    reason: changes.map((c) => `${c.field} ${c.from}→${c.to}`).join(', '),
    changes,
    next: { risk, rules },
  };
}

export async function applyMuseImprove(
  bots: any[],
  opts: {
    env?: string;
    dryRun?: boolean;
    save?: (p: MuseImproveProposal, env: string) => Promise<void>;
    log?: typeof audit;
    now?: () => string;
    limit?: number;
    /** Tests pass false so a heuristic run cannot stamp lastTune (or a DB row). */
    persistLastTune?: boolean;
  } = {},
): Promise<{ applied: MuseImproveProposal[]; skipped: number }> {
  const env = opts.env || await getTradingEnv().catch(() => 'alpaca_paper');
  if (isLiveEnv(env as any) || env !== 'alpaca_paper') {
    return { applied: [], skipped: bots.length };
  }
  const write = opts.log || audit;
  const applied: MuseImproveProposal[] = [];
  const cap = Math.max(1, opts.limit ?? 8);
  for (const bot of bots) {
    if (applied.length >= cap) break;
    const p = proposeMuseImprove(bot);
    if (!p) continue;
    applied.push(p);
    if (opts.dryRun) continue;
    if (opts.save) await opts.save(p, env);
    else if (p.id != null && opts.persistLastTune !== false) {
      await exec(
        `UPDATE bots SET risk=CAST(:risk AS JSON), rules=CAST(:rules AS JSON) WHERE id=:id AND env=:env`,
        { risk: JSON.stringify(p.next.risk), rules: JSON.stringify(p.next.rules), id: p.id, env },
      );
    }
    if (opts.persistLastTune !== false) {
      lastTune = {
        at: opts.now ? opts.now() : new Date().toISOString(),
        botId: p.id,
        name: p.name,
        missingBot: p.id == null,
        because: p.reason,
      };
    }
    if (opts.persistLastTune === false && !opts.log) continue;
    await write(
      'muse.improve',
      `${p.name}: ${p.reason}`.slice(0, 240),
      { id: p.id, env, changes: p.changes, before: { risk: parseJsonish(bot.risk), rules: parseJsonish(bot.rules) }, after: p.next },
    ).catch(() => {});
  }
  return { applied, skipped: bots.length - applied.length };
}

export type ClosedMonitorTuneInput = {
  id?: number | null;
  bot_id?: number | null;
  symbol?: string | null;
  reason?: string | null;
  entry_price?: number | null;
  exit_price?: number | null;
  bot_name?: string | null;
};

/**
 * Learn from a closed monitor. With bot_id, lastTune names that bot and a
 * paper improve proposal may be saved. Without bot_id, lastTune says the bot
 * is missing and nothing is written. persistLastTune:false (tests) does not
 * touch the process stamp or the database.
 */
export async function tuneFromClosedMonitor(
  monitor: ClosedMonitorTuneInput,
  opts: {
    env?: string;
    persistLastTune?: boolean;
    allowDb?: boolean;
    now?: () => string;
    bot?: any;
    loadBot?: (id: number, env: string) => Promise<any | null>;
    save?: (p: MuseImproveProposal, env: string) => Promise<void>;
    log?: typeof audit;
  } = {},
): Promise<{ learned: boolean; lastTune: MuseLastTune; applied: MuseImproveProposal | null }> {
  const at = opts.now ? opts.now() : new Date().toISOString();
  const persist = opts.persistLastTune !== false;
  const env = opts.env || 'alpaca_paper';
  const botId = Number(monitor.bot_id);
  const hasBot = Number.isInteger(botId) && botId > 0;
  if (!hasBot) {
    const tune: MuseLastTune = {
      at,
      botId: null,
      name: 'bot missing',
      missingBot: true,
      symbol: monitor.symbol ?? null,
      because: 'closed monitor had no bot id, so Muse did not learn a bot',
    };
    if (persist) lastTune = tune;
    return { learned: false, lastTune: tune, applied: null };
  }

  let bot = opts.bot ?? null;
  if (!bot && opts.loadBot) bot = await opts.loadBot(botId, env);
  if (!bot && persist && opts.allowDb && env === 'alpaca_paper') {
    const [row] = await q<any>(
      'SELECT id, name, enabled, mode, action, rules, risk, last_result FROM bots WHERE id=:id AND env=:env',
      { id: botId, env },
    );
    bot = row || null;
  }
  const name = String(bot?.name || monitor.bot_name || `bot #${botId}`);
  let applied: MuseImproveProposal | null = null;
  if (bot && env === 'alpaca_paper' && !isLiveEnv(env as any)) {
    applied = proposeMuseImprove({ ...bot, id: bot.id ?? botId, name });
    if (applied && persist && (opts.allowDb || opts.save)) {
      if (opts.save) await opts.save(applied, env);
      else {
        await exec(
          `UPDATE bots SET risk=CAST(:risk AS JSON), rules=CAST(:rules AS JSON) WHERE id=:id AND env=:env`,
          { risk: JSON.stringify(applied.next.risk), rules: JSON.stringify(applied.next.rules), id: botId, env },
        );
      }
    }
  }
  const because = applied
    ? applied.reason
    : `learned close ${monitor.symbol || ''} ${monitor.reason || ''}`.replace(/\s+/g, ' ').trim();
  const tune: MuseLastTune = {
    at,
    botId,
    name,
    missingBot: false,
    symbol: monitor.symbol ?? null,
    because,
  };
  if (persist) {
    lastTune = tune;
    if (opts.allowDb || opts.log) {
      const write = opts.log || audit;
      await write('muse.tune', `${name}: ${because}`.slice(0, 240), {
        id: monitor.id ?? null,
        botId,
        symbol: monitor.symbol ?? null,
        learned: true,
      }).catch(() => {});
    }
  }
  return { learned: true, lastTune: tune, applied };
}
