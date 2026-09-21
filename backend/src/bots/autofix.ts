/**
 * Standing paper-desk autofix: park issue bots as observe (watch only) and
 * clamp new-entry exits to Monday swing law. Never widens live open-position
 * stops — only bot config used for future entries. Muse/Jev do not place.
 */

import { audit, exec, getKillSwitch, getTradingEnv, q } from '../db.js';
import { isLiveEnv, type Mode } from '../config.js';
import { isLeapsTrade } from '../risk/dte.js';
import {
  HARD_STOP_PCT,
  SOFT_TAKE_PROFIT_PCT,
  SWING_TRAIL_PCT,
} from '../risk/exitpolicy.js';
import { isObserveOnlyBot, parseJsonish } from '../risk/observe.js';
import { isShortDtePrivileged, SHORT_DTE_BAND, SHORT_DTE_RAILS } from '../risk/shortdte.js';

export const AUTOFIX_TRAIL_MIN = 8;
export const AUTOFIX_TRAIL_MAX = 15;

export type AutofixChange = { field: string; from: unknown; to: unknown };

export type AutofixProposal = {
  id: number | null;
  name: string;
  reason: string;
  changes: AutofixChange[];
  next: {
    mode: Mode;
    asset_class: string;
    action: Record<string, any>;
    risk: Record<string, any>;
  };
};

export type AutofixSkip = { id: number | null; name: string; reason: string };

export type AutofixResult = {
  ok: boolean;
  dry_run: boolean;
  env: string;
  refused?: boolean;
  fixed: AutofixProposal[];
  skipped: AutofixSkip[];
  summary: string;
};

export type AutofixHealth = {
  lastRun: string | null;
  lastFixedCount: number;
  lastError: string | null;
};

let lastRun: string | null = null;
let lastFixedCount = 0;
let lastError: string | null = null;

export function autofixHealth(): AutofixHealth {
  return { lastRun, lastFixedCount, lastError };
}

export function resetAutofixForTests(): void {
  lastRun = null;
  lastFixedCount = 0;
  lastError = null;
}

function clone<T>(v: T): T {
  return v == null ? v : JSON.parse(JSON.stringify(v));
}

function eq(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function strategyKey(action: any, risk: any): string {
  return String(action?._strategy || action?.strategy || action?._play?.key || risk?._strategy || '').trim();
}

function looksLikePut(action: any, name: string): boolean {
  if (String(action?.option_type || '').toLowerCase() === 'put') return true;
  if (String(action?._play?.direction || '').toLowerCase() === 'put') return true;
  return /\b(long[- ]put|put hedge|put breakdown|options-puts|— long put)\b/i.test(name);
}

function looksLikeCoveredOrSell(action: any, name: string): boolean {
  if (action?.covered === true || action?.covered === 1) return true;
  if (/covered[- ]call/i.test(name)) return true;
  const side = String(action?.side || '').toLowerCase();
  const ot = String(action?.option_type || '').toLowerCase();
  return side === 'sell' && (ot === 'call' || ot === 'put' || /covered|write|income/i.test(name));
}

function explicitShortDte(action: any, risk: any): boolean {
  const dtes = [action?._dte, action?._play?.dte, risk?._dte];
  if (dtes.some((d) => Number(d) === 0 || Number(d) === 1)) return true;
  return !!(action?.allow_0_1_dte || risk?.allow_0_1_dte);
}

export type AutofixClass =
  | 'observe_stub'
  | 'put'
  | 'equity'
  | 'sell'
  | 'short_dte'
  | 'leaps'
  | 'long_call'
  | 'ok';

export function classifyBotForAutofix(bot: any): AutofixClass {
  const action = parseJsonish(bot?.action) ?? bot?.action ?? {};
  const risk = parseJsonish(bot?.risk) ?? bot?.risk ?? {};
  const name = String(bot?.name || '');
  const key = strategyKey(action, risk);
  if (isObserveOnlyBot(bot)) return 'observe_stub';
  if (looksLikePut(action, name)) return 'put';
  if (looksLikeCoveredOrSell(action, name)) return 'sell';
  const privileged = isShortDtePrivileged({ key, name, keys: [action?._play?.key, action?._strategy] });
  if (explicitShortDte(action, risk) && !privileged) return 'short_dte';
  const leaps = isLeapsTrade({
    expiration: action?.expiration,
    name,
    key,
    dte: Number(action?._dte) || Number(action?._play?.dte) || null,
  });
  if (leaps) return 'leaps';
  if (String(action?.option_type || '').toLowerCase() === 'call') return 'long_call';
  if (!action?.option_type) return 'equity';
  return 'ok';
}

function clampTrail(raw: unknown, fallback = SWING_TRAIL_PCT): number {
  const n = Number(raw);
  if (Number.isFinite(n) && n >= AUTOFIX_TRAIL_MIN && n <= AUTOFIX_TRAIL_MAX) return n;
  return fallback;
}

/** Swing-law entry exits. Privileged 0–1 keep the tighter short-DTE rails. */
export function clampExitBand(
  band: Record<string, any> | null | undefined,
  opts: { privilegedShort?: boolean } = {},
): Record<string, any> {
  const next = { ...(band && typeof band === 'object' ? band : {}) };
  if (opts.privilegedShort) {
    const sl = Number(next.stop_loss_pct ?? next.sl);
    next.stop_loss_pct = Number.isFinite(sl) && sl > 0
      ? Math.min(sl, SHORT_DTE_RAILS.slMax)
      : SHORT_DTE_RAILS.slMax;
    if ('sl' in next) next.sl = next.stop_loss_pct;
    const tp = Number(next.take_profit_pct ?? next.tp);
    next.take_profit_pct = Number.isFinite(tp) && tp >= SHORT_DTE_RAILS.tpMin && tp <= SHORT_DTE_RAILS.tpMax
      ? tp
      : 10;
    if ('tp' in next) next.tp = next.take_profit_pct;
    const trail = Number(next.trailing_stop_pct ?? next.trail);
    next.trailing_stop_pct = Number.isFinite(trail) && trail > 0
      ? Math.min(trail, SHORT_DTE_RAILS.trailMax)
      : SHORT_DTE_BAND.trail;
    if ('trail' in next) next.trail = next.trailing_stop_pct;
    return next;
  }
  const sl = Number(next.stop_loss_pct ?? next.sl);
  next.stop_loss_pct = Number.isFinite(sl) && sl > 0 ? Math.min(sl, HARD_STOP_PCT) : HARD_STOP_PCT;
  if ('sl' in next) next.sl = next.stop_loss_pct;
  next.take_profit_pct = SOFT_TAKE_PROFIT_PCT;
  if ('tp' in next) next.tp = SOFT_TAKE_PROFIT_PCT;
  next.trailing_stop_pct = clampTrail(next.trailing_stop_pct ?? next.trail);
  if ('trail' in next) next.trail = next.trailing_stop_pct;
  return next;
}

function clampDteBands(risk: Record<string, any>, privilegedBot: boolean): void {
  const bands = risk.dte_bands;
  if (!bands || typeof bands !== 'object') return;
  for (const [k, raw] of Object.entries(bands)) {
    if (!raw || typeof raw !== 'object') continue;
    const dte = Number(k);
    const short = (dte === 0 || dte === 1) && privilegedBot;
    bands[k] = clampExitBand(raw as Record<string, any>, { privilegedShort: short });
  }
}

function clampPlayLists(action: Record<string, any>): void {
  const lists: any[][] = [];
  if (Array.isArray(action.plays)) lists.push(action.plays);
  const sp = action.symbol_plays;
  if (sp && typeof sp === 'object') {
    for (const v of Object.values(sp)) if (Array.isArray(v)) lists.push(v);
  }
  for (const list of lists) {
    for (const play of list) {
      if (!play || typeof play !== 'object') continue;
      const privileged = isShortDtePrivileged({ key: play.key, name: play.name });
      const dte = Number(play.dte);
      if (play.risk && typeof play.risk === 'object') {
        play.risk = clampExitBand(play.risk, { privilegedShort: privileged && (dte === 0 || dte === 1) });
      }
    }
  }
}

const CLASS_REASON: Record<AutofixClass, string> = {
  observe_stub: 'observe-only stub — stay watch, never promote',
  put: 'put → observe (watch only)',
  equity: 'equity (no option_type) → observe',
  sell: 'covered-call / option sell → observe',
  short_dte: 'explicit 0–1 DTE (not on allowlist) → observe',
  leaps: 'long-call LEAPS → full_auto call buy',
  long_call: 'long call → full_auto call buy',
  ok: 'exit clamp only',
};

/** Pure. Mutates nothing on `bot`. Null when already compliant. */
export function proposeBotAutofix(bot: any): AutofixProposal | null {
  const origAction = clone(parseJsonish(bot?.action) ?? bot?.action ?? {}) || {};
  const origRisk = clone(parseJsonish(bot?.risk) ?? bot?.risk ?? {}) || {};
  const action = clone(origAction);
  const risk = clone(origRisk);
  const name = String(bot?.name || `bot #${bot?.id ?? '?'}`);
  const klass = classifyBotForAutofix(bot);
  const key = strategyKey(action, risk);
  const privileged = isShortDtePrivileged({ key, name, keys: [action?._play?.key] });

  let mode = String(bot?.mode || 'observe') as Mode;
  let asset_class = String(bot?.asset_class || 'equity');

  if (klass === 'observe_stub' || klass === 'put' || klass === 'equity' || klass === 'sell' || klass === 'short_dte') {
    mode = 'observe';
    if (klass !== 'observe_stub') action._observe_only = true;
  } else if (klass === 'leaps' || klass === 'long_call') {
    mode = 'full_auto';
    asset_class = 'option';
    action.option_type = 'call';
    action.side = 'buy';
    delete action._observe_only;
    delete action.observe_only;
    delete action.covered;
    // LEAPS keep far expiration; non-LEAPS stay on their weekly/monthly (2–14 gate).
  }

  const nextRisk = clampExitBand(risk, { privilegedShort: privileged && klass !== 'short_dte' && klass !== 'put' });
  Object.assign(risk, nextRisk);
  clampDteBands(risk, privileged);
  clampPlayLists(action);

  const changes: AutofixChange[] = [];
  if (mode !== String(bot?.mode || '')) changes.push({ field: 'mode', from: bot?.mode ?? null, to: mode });
  if (asset_class !== String(bot?.asset_class || '')) {
    changes.push({ field: 'asset_class', from: bot?.asset_class ?? null, to: asset_class });
  }
  if (!eq(origAction, action)) changes.push({ field: 'action', from: origAction, to: action });
  if (!eq(origRisk, risk)) changes.push({ field: 'risk', from: origRisk, to: risk });
  if (!changes.length) return null;

  return {
    id: bot?.id != null ? Number(bot.id) : null,
    name,
    reason: CLASS_REASON[klass],
    changes,
    next: { mode, asset_class, action, risk },
  };
}

export async function runBotsAutofix(opts: {
  env?: string;
  dryRun?: boolean;
  loadBots?: (env: string) => Promise<any[]>;
  saveBot?: (row: AutofixProposal, env: string) => Promise<void>;
  log?: typeof audit;
  now?: () => string;
} = {}): Promise<AutofixResult> {
  const dryRun = !!opts.dryRun;
  const at = opts.now ? opts.now() : new Date().toISOString();
  let env = opts.env || 'alpaca_paper';
  const write = opts.log || audit;
  try {
    env = opts.env || await getTradingEnv();
    if (!dryRun && (env !== 'alpaca_paper' || isLiveEnv(env as any))) {
      lastRun = at;
      lastError = 'refusing — autofix persist is Alpaca paper only';
      return {
        ok: false,
        dry_run: false,
        env,
        refused: true,
        fixed: [],
        skipped: [],
        summary: lastError,
      };
    }
    if (!dryRun && !opts.loadBots && await getKillSwitch()) {
      lastRun = at;
      lastError = 'kill switch on — autofix skipped';
      return { ok: true, dry_run: false, env, fixed: [], skipped: [], summary: lastError };
    }

    const bots = opts.loadBots
      ? await opts.loadBots(env)
      : await q<any>('SELECT * FROM bots WHERE env=:env ORDER BY id ASC', { env });

    const fixed: AutofixProposal[] = [];
    const skipped: AutofixSkip[] = [];
    for (const bot of bots || []) {
      const proposal = proposeBotAutofix(bot);
      if (!proposal) {
        skipped.push({ id: bot.id ?? null, name: String(bot.name || ''), reason: 'already compliant' });
        continue;
      }
      fixed.push(proposal);
      if (!dryRun) {
        if (opts.saveBot) {
          await opts.saveBot(proposal, env);
        } else if (proposal.id != null) {
          await exec(
            `UPDATE bots SET mode=:mode, asset_class=:ac, action=CAST(:action AS JSON), risk=CAST(:risk AS JSON)
             WHERE id=:id AND env=:env`,
            {
              mode: proposal.next.mode,
              ac: proposal.next.asset_class,
              action: JSON.stringify(proposal.next.action),
              risk: JSON.stringify(proposal.next.risk),
              id: proposal.id,
              env,
            },
          );
        }
        await write(
          'bot.autofix',
          `${proposal.name}: ${proposal.reason} [${proposal.changes.map((c) => c.field).join(',')}]`.slice(0, 240),
          {
            id: proposal.id,
            env,
            reason: proposal.reason,
            changes: proposal.changes.map((c) => c.field),
          },
        ).catch(() => {});
      }
    }

    lastRun = at;
    lastFixedCount = dryRun ? lastFixedCount : fixed.length;
    lastError = null;
    const summary = dryRun
      ? `dry-run: ${fixed.length} would fix, ${skipped.length} already compliant`
      : `fixed ${fixed.length}, skipped ${skipped.length}`;
    if (!dryRun && fixed.length) {
      await write('bot.autofix.summary', summary, { env, fixed: fixed.map((f) => f.id) }).catch(() => {});
    }
    return { ok: true, dry_run: dryRun, env, fixed, skipped, summary };
  } catch (e: any) {
    const msg = String(e?.message || e).slice(0, 240);
    lastRun = at;
    lastError = msg;
    await write('bot.autofix.error', msg, { env }).catch(() => {});
    return { ok: false, dry_run: dryRun, env, fixed: [], skipped: [], summary: msg };
  }
}
