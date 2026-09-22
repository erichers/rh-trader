/**
 * Standing paper-desk autofix: park issue bots as observe (watch only) and
 * clamp new-entry exits to Monday swing law. Leftover equity rows are DELETED
 * (never converted to calls, never parked). Never widens live open-position
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
import { OBSERVE_STUB_KEYS, OBSERVE_STUB_NAMES, parseJsonish } from '../risk/observe.js';
import { isShortDtePrivileged, SHORT_DTE_BAND, SHORT_DTE_RAILS } from '../risk/shortdte.js';
import { isDeletedLeftoverEquity, isEquityAssetClass } from '../risk/optionsonly.js';
import { clampIndexQuickbotUniverse, isIndexQuickbotName, parseSymbolList } from './indexUniverse.js';
import { isHumanArmed, isSignalHold, isZeroDteCandidate } from './signalHold.js';

export const AUTOFIX_TRAIL_MIN = 8;
export const AUTOFIX_TRAIL_MAX = 15;

export type AutofixChange = { field: string; from: unknown; to: unknown };

export type AutofixProposal = {
  id: number | null;
  name: string;
  reason: string;
  changes: AutofixChange[];
  /** Equity leftovers are deleted, not parked or converted. */
  delete?: boolean;
  next: {
    mode: Mode;
    enabled: number;
    asset_class: string;
    action: Record<string, any>;
    risk: Record<string, any>;
    clearLastResult: boolean;
    /** Set when Index QuickBot symbols drifted off SPY and QQQ. */
    symbols?: string[];
  };
};

export type AutofixSkip = { id: number | null; name: string; reason: string };

export type AutofixResult = {
  ok: boolean;
  dry_run: boolean;
  env: string;
  refused?: boolean;
  fixed: AutofixProposal[];
  deleted: AutofixProposal[];
  skipped: AutofixSkip[];
  summary: string;
};

export type NullBotClose = { symbol: string; nullCloses: number };

export type AutofixHealth = {
  lastRun: string | null;
  lastFixedCount: number;
  lastError: string | null;
  /** Recent closed monitors with no bot_id, grouped when a symbol is chronic. */
  nullBotMonitors: NullBotClose[];
};

let lastRun: string | null = null;
let lastFixedCount = 0;
let lastError: string | null = null;
let nullBotMonitors: NullBotClose[] = [];
let nullLoadedAt = 0;

/** Same symbol, at least `min` recent closes, all missing bot_id. Does not disable bots. */
export function chronicNullBotCloses(
  rows: { symbol?: string | null; bot_id?: number | null }[],
  min = 3,
): NullBotClose[] {
  const counts = new Map<string, number>();
  for (const r of rows) {
    const id = Number(r.bot_id);
    if (Number.isInteger(id) && id > 0) continue;
    const symbol = String(r.symbol || '').trim().toUpperCase();
    if (!symbol) continue;
    counts.set(symbol, (counts.get(symbol) || 0) + 1);
  }
  return [...counts.entries()]
    .filter(([, n]) => n >= min)
    .map(([symbol, nullCloses]) => ({ symbol, nullCloses }))
    .sort((a, b) => b.nullCloses - a.nullCloses || a.symbol.localeCompare(b.symbol));
}

export function noteNullBotMonitors(rows: { symbol?: string | null; bot_id?: number | null }[]): void {
  nullBotMonitors = chronicNullBotCloses(rows);
  nullLoadedAt = Date.now();
}

/** Health poll. Failures do not stick, so a down DB retries next call. */
export async function refreshNullBotMonitors(load?: () => Promise<{ symbol?: string | null; bot_id?: number | null }[]>): Promise<void> {
  if (nullLoadedAt && Date.now() - nullLoadedAt < 60_000) return;
  try {
    const rows = load
      ? await load()
      : await q<{ symbol: string; bot_id: number | null }>(
        `SELECT symbol, bot_id FROM position_monitors
          WHERE status='closed' AND bot_id IS NULL
            AND (env=:env OR (env IS NULL AND :env='alpaca_paper'))
            AND closed_at >= DATE_SUB(NOW(), INTERVAL 7 DAY)`,
        { env: 'alpaca_paper' },
      );
    nullBotMonitors = chronicNullBotCloses(rows || []);
    nullLoadedAt = Date.now();
  } catch {
    /* leave the previous snapshot; retry next health poll */
  }
}

export function autofixHealth(): AutofixHealth {
  return { lastRun, lastFixedCount, lastError, nullBotMonitors };
}

export function resetAutofixForTests(): void {
  lastRun = null;
  lastFixedCount = 0;
  lastError = null;
  nullBotMonitors = [];
  nullLoadedAt = 0;
}

function clone<T>(v: T): T {
  return v == null ? v : JSON.parse(JSON.stringify(v));
}

function eq(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function hasLastResult(v: unknown): boolean {
  if (v == null || v === '') return false;
  if (typeof v === 'string') {
    const s = v.trim();
    if (!s || s === 'null' || s === '[]' || s === '{}') return false;
    return true;
  }
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === 'object') return Object.keys(v as object).length > 0;
  return true;
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

function isLibraryWatchStub(bot: any, action: any, risk: any): boolean {
  const name = String(bot?.name || '').trim().toLowerCase();
  if (name && (OBSERVE_STUB_NAMES as readonly string[]).some((n) => n.toLowerCase() === name)) return true;
  const key = strategyKey(action, risk).toLowerCase();
  return !!(key && (OBSERVE_STUB_KEYS as readonly string[]).includes(key));
}

export function classifyBotForAutofix(bot: any): AutofixClass {
  const action = parseJsonish(bot?.action) ?? bot?.action ?? {};
  const risk = parseJsonish(bot?.risk) ?? bot?.risk ?? {};
  const name = String(bot?.name || '');
  const key = strategyKey(action, risk);
  // Off-rails first. A prior autofix may have stamped `_observe_only` on equity/puts —
  // those are not library watch stubs and must still disable + clear last_result.
  if (looksLikePut(action, name)) return 'put';
  if (looksLikeCoveredOrSell(action, name)) return 'sell';
  // Options basket. A missing top-level option_type must not delete it as equity.
  if (isIndexQuickbotName(name) && !isEquityAssetClass(bot?.asset_class)) return 'ok';
  const privileged = isShortDtePrivileged({ key, name, keys: [action?._play?.key, action?._strategy] });
  if (explicitShortDte(action, risk) && !privileged) return 'short_dte';
  if (isLibraryWatchStub(bot, action, risk)) return 'observe_stub';
  const leaps = isLeapsTrade({
    expiration: action?.expiration,
    name,
    key,
    dte: Number(action?._dte) || Number(action?._play?.dte) || null,
  });
  if (leaps) return 'leaps';
  if (String(action?.option_type || '').toLowerCase() === 'call') return 'long_call';
  // Share lot, unlabeled leftover, or a Mac-deleted equity name without a call spec.
  if (
    isEquityAssetClass(bot?.asset_class)
    || !action?.option_type
    || isDeletedLeftoverEquity({ name, key, action })
  ) return 'equity';
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
  put: 'put → observe + disabled (clear last_result)',
  equity: 'equity → DELETE (options-only desk; do not convert/park)',
  sell: 'covered-call / option sell → observe + disabled (clear last_result)',
  short_dte: 'explicit 0–1 DTE (not on allowlist) → observe + disabled (clear last_result)',
  leaps: 'long-call LEAPS → full_auto call buy',
  long_call: 'long call → full_auto call buy',
  ok: 'exit clamp only',
};

/** Pure. Mutates nothing on `bot`. Null when already compliant. */
export function proposeBotAutofix(bot: any): AutofixProposal | null {
  const origAction = clone(parseJsonish(bot?.action) ?? bot?.action ?? {}) || {};
  const origRisk = clone(parseJsonish(bot?.risk) ?? bot?.risk ?? {}) || {};
  let action = clone(origAction);
  const risk = clone(origRisk);
  let symbols: string[] | undefined;
  const universe = clampIndexQuickbotUniverse({ name: bot?.name, symbols: bot?.symbols, action });
  if (universe) {
    action = universe.action;
    symbols = universe.symbols;
  }
  const name = String(bot?.name || `bot #${bot?.id ?? '?'}`);
  const klass = classifyBotForAutofix(bot);
  const key = strategyKey(action, risk);
  const privileged = isShortDtePrivileged({ key, name, keys: [action?._play?.key] });

  let mode = String(bot?.mode || 'observe') as Mode;
  let asset_class = String(bot?.asset_class || 'option');
  const wasEnabled = bot?.enabled === true || bot?.enabled === 1 || bot?.enabled === '1';
  let enabled = wasEnabled ? 1 : 0;
  let clearLastResult = false;
  if (klass === 'equity') {
    return {
      id: bot?.id != null ? Number(bot.id) : null,
      name,
      reason: CLASS_REASON.equity,
      delete: true,
      changes: [{ field: 'row', from: 'present', to: 'deleted' }],
      next: { mode: 'observe', enabled: 0, asset_class: 'equity', action, risk, clearLastResult: true },
    };
  }
  const offRails = klass === 'put' || klass === 'sell' || klass === 'short_dte';

  if (klass === 'observe_stub' || offRails) {
    mode = 'observe';
    if (offRails) {
      enabled = 0;
      action._observe_only = true;
      // Stale allowlist skips on last_result paint the Bots banner red even after observe.
      if (hasLastResult(bot?.last_result)) clearLastResult = true;
    }
  } else if (klass === 'leaps' || klass === 'long_call') {
    // Wait-for-signal / _ai_boom stay observe and disabled until a person arms
    // them. `_full_auto_ok` is not an arm. 0-DTE is parked below.
    const signalHeld = isSignalHold(action) || isSignalHold(risk);
    const human = isHumanArmed(action) || isHumanArmed(risk);
    const zeroDte = isZeroDteCandidate({ id: bot?.id, name, action, risk });
    asset_class = 'option';
    action.option_type = 'call';
    action.side = 'buy';
    if (signalHeld && !human) {
      mode = 'observe';
      enabled = 0;
      if (action._full_auto_ok === true) action._full_auto_ok = false;
    } else if (!signalHeld && !zeroDte) {
      mode = 'full_auto';
      delete action._observe_only;
      delete action.observe_only;
      delete action.covered;
    }
    // LEAPS keep far expiration; non-LEAPS stay on their weekly/monthly (2–14 gate).
  }

  if (isZeroDteCandidate({ id: bot?.id, name, action, risk })) {
    mode = 'observe';
    enabled = 0;
    if (action._full_auto_ok === true) action._full_auto_ok = false;
  }

  const nextRisk = clampExitBand(risk, { privilegedShort: privileged && klass !== 'short_dte' && klass !== 'put' });
  Object.assign(risk, nextRisk);
  clampDteBands(risk, privileged);
  clampPlayLists(action);
  // Standing law 2026-09-21: hold overnight/weekend (LEAPS + swing calls).
  risk.hold_overnight = true;
  risk.hold_over_weekend = true;

  const changes: AutofixChange[] = [];
  if (mode !== String(bot?.mode || '')) changes.push({ field: 'mode', from: bot?.mode ?? null, to: mode });
  if (enabled !== (wasEnabled ? 1 : 0)) changes.push({ field: 'enabled', from: wasEnabled ? 1 : 0, to: enabled });
  if (asset_class !== String(bot?.asset_class || '')) {
    changes.push({ field: 'asset_class', from: bot?.asset_class ?? null, to: asset_class });
  }
  if (!eq(origAction, action)) changes.push({ field: 'action', from: origAction, to: action });
  if (!eq(origRisk, risk)) changes.push({ field: 'risk', from: origRisk, to: risk });
  if (clearLastResult) changes.push({ field: 'last_result', from: bot?.last_result ?? null, to: null });
  if (symbols) changes.push({ field: 'symbols', from: parseSymbolList(bot?.symbols), to: symbols });
  if (!changes.length) return null;

  return {
    id: bot?.id != null ? Number(bot.id) : null,
    name,
    reason: symbols ? `${CLASS_REASON[klass]}; symbols clamped to SPY, QQQ` : CLASS_REASON[klass],
    changes,
    next: { mode, enabled, asset_class, action, risk, clearLastResult, ...(symbols ? { symbols } : {}) },
  };
}

export async function runBotsAutofix(opts: {
  env?: string;
  dryRun?: boolean;
  loadBots?: (env: string) => Promise<any[]>;
  saveBot?: (row: AutofixProposal, env: string) => Promise<void>;
  deleteBot?: (row: AutofixProposal, env: string) => Promise<void>;
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
        deleted: [],
        skipped: [],
        summary: lastError,
      };
    }
    if (!dryRun && !opts.loadBots && await getKillSwitch()) {
      lastRun = at;
      lastError = 'kill switch on — autofix skipped';
      return { ok: true, dry_run: false, env, fixed: [], deleted: [], skipped: [], summary: lastError };
    }

    const bots = opts.loadBots
      ? await opts.loadBots(env)
      : await q<any>('SELECT * FROM bots WHERE env=:env ORDER BY id ASC', { env });

    const fixed: AutofixProposal[] = [];
    const deleted: AutofixProposal[] = [];
    const skipped: AutofixSkip[] = [];
    for (const bot of bots || []) {
      const proposal = proposeBotAutofix(bot);
      if (!proposal) {
        skipped.push({ id: bot.id ?? null, name: String(bot.name || ''), reason: 'already compliant' });
        continue;
      }
      if (proposal.delete) deleted.push(proposal);
      else fixed.push(proposal);
      if (!dryRun) {
        if (proposal.delete) {
          if (opts.deleteBot) {
            await opts.deleteBot(proposal, env);
          } else if (opts.saveBot) {
            await opts.saveBot(proposal, env);
          } else if (proposal.id != null) {
            await exec('DELETE FROM bots WHERE id=:id AND env=:env', { id: proposal.id, env });
          }
        } else if (opts.saveBot) {
          await opts.saveBot(proposal, env);
        } else if (proposal.id != null) {
          await exec(
            `UPDATE bots SET mode=:mode, enabled=:enabled, asset_class=:ac, action=CAST(:action AS JSON), risk=CAST(:risk AS JSON)
             ${proposal.next.symbols ? ', symbols=CAST(:symbols AS JSON)' : ''}
             ${proposal.next.clearLastResult ? ', last_result=NULL' : ''}
             WHERE id=:id AND env=:env`,
            {
              mode: proposal.next.mode,
              enabled: proposal.next.enabled,
              ac: proposal.next.asset_class,
              action: JSON.stringify(proposal.next.action),
              risk: JSON.stringify(proposal.next.risk),
              symbols: proposal.next.symbols ? JSON.stringify(proposal.next.symbols) : null,
              id: proposal.id,
              env,
            },
          );
        }
        await write(
          proposal.delete ? 'bot.autofix.delete' : 'bot.autofix',
          `${proposal.name}: ${proposal.reason} [${proposal.changes.map((c) => c.field).join(',')}]`.slice(0, 240),
          {
            id: proposal.id,
            env,
            reason: proposal.reason,
            changes: proposal.changes.map((c) => c.field),
            deleted: !!proposal.delete,
          },
        ).catch(() => {});
      }
    }

    lastRun = at;
    lastFixedCount = dryRun ? lastFixedCount : fixed.length + deleted.length;
    lastError = null;
    const summary = dryRun
      ? `dry-run: ${deleted.length} would delete, ${fixed.length} would fix, ${skipped.length} already compliant`
      : `deleted ${deleted.length} equity, fixed ${fixed.length}, skipped ${skipped.length}`;
    if (!dryRun && (fixed.length || deleted.length)) {
      await write('bot.autofix.summary', summary, {
        env,
        fixed: fixed.map((f) => f.id),
        deleted: deleted.map((d) => d.id),
      }).catch(() => {});
    }
    return { ok: true, dry_run: dryRun, env, fixed, deleted, skipped, summary };
  } catch (e: any) {
    const msg = String(e?.message || e).slice(0, 240);
    lastRun = at;
    lastError = msg;
    await write('bot.autofix.error', msg, { env }).catch(() => {});
    return { ok: false, dry_run: dryRun, env, fixed: [], deleted: [], skipped: [], summary: msg };
  }
}
