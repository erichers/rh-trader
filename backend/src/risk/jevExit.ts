/**
 * Jev exit panel for an open paper option.
 *
 * Asks CLOSE | PARTIAL | HOLD | TIGHTEN_TRAIL. The monitor applies the result
 * only after the swing-law rail has already had its say. A hard stop is never cleared.
 * Per-bot exit off still logs a local opinion and does not call TypeSafe.
 */

import { config } from '../config.js';
import { choice, type ChoiceAnswer } from './decide.js';
import { canCallJevApi, loadJevSpend, recordJevUsage, type JevBudgetIo } from './jevBudget.js';
import {
  appendJevJsonl,
  buildJevState,
  jevModel,
  resolveJevClient,
  typesafeApiKey,
  type JevClient,
  type JevEntryState,
} from './jev.js';
import {
  jevCadenceKey,
  jevEffective,
  parseJevDte,
  rememberCadence,
  takeFreshCadence,
  type JevBotFlags,
  type JevEffective,
  type JevExitAction,
} from './jevScope.js';
import { effectiveJevMode, loadJevSettings, parseJevUiMode, type JevUiMode } from './jevSettings.js';
import { jevExitCadenceWindowMs } from './jevWave1.js';

export const JEV_EXIT_OPTIONS = ['hold', 'exit', 'partial', 'tighten'] as const;
export type JevExitPick = JevExitAction;

export type JevExitPanel = {
  thesis_intact?: number | null;
  action?: { choice?: string | null; confidence?: number | null } | null;
  giveback_risk?: { score?: number | null; confidence?: number | null } | null;
  time_pressure?: number | null;
};

export type JevExitGate = {
  pick: JevExitPick;
  opinion: JevExitPick;
  confidence: number;
  because: string;
  failOpen: boolean;
  called: boolean;
  applied: boolean;
  mode: 'shadow' | 'active';
  skipped: string | null;
  answer: ChoiceAnswer<JevExitPick>;
  panel?: JevExitPanel;
};

export type JevExitInput = JevEntryState & {
  monitor_id?: number | string | null;
  occ?: string | null;
  fav?: number | null;
  peak?: number | null;
  trail_pct?: number | null;
  sl_pct?: number | null;
  entry_price?: number | null;
  last_price?: number | null;
  qty?: number | null;
  leaps?: boolean | null;
};

const EXIT_CONF_MIN = 0.75;

export function parseJevExitPick(raw: unknown): JevExitPick | null {
  const s = String(raw || '').toLowerCase().replace(/[\s-]+/g, '_');
  if (s === 'close') return 'exit';
  if (s === 'partial') return 'partial';
  if (s === 'tighten_trail' || s === 'size_down' || s === 'sizedown') return 'tighten';
  if (s === 'hold' || s === 'exit' || s === 'tighten' || s === 'partial') return s;
  return null;
}

export function jevExitQuestions() {
  return {
    thesis_intact: {
      type: 'noul' as const,
      instructions: 'The long-call thesis that opened this Alpaca paper position is still intact. This is not a price forecast.',
      criteria: {
        true: 'Thesis still holds',
        false: 'Thesis is stale or broken',
      },
    },
    action: {
      type: 'choice' as const,
      instructions: 'Advise this open Alpaca paper long call. Code already owns the hard stop, the gain-lock floor, and the trail. You cannot turn those off, widen them, add size, or use Robinhood. CLOSE sells the rest. PARTIAL sells part and keeps a remainder. HOLD leaves the rail plan. TIGHTEN_TRAIL narrows the trail only. Not a price prediction.',
      criteria: {
        hold: 'HOLD. Keep the position. Rails stay in charge.',
        exit: 'CLOSE. Thesis is broken enough to sell the remaining contracts now.',
        partial: 'PARTIAL. Sell part of the contracts. Never add. A single contract cannot partial.',
        tighten: 'TIGHTEN_TRAIL. Stay in, but narrow the trailing stop. Do not loosen the hard stop.',
      },
    },
    giveback_risk: {
      type: 'score' as const,
      instructions: 'How much open gain could be given back before the trail acts. Not a price target.',
      criteria: ['low', 'medium', 'high'],
    },
    time_pressure: {
      type: 'noul' as const,
      instructions: 'Time decay or a short remaining life makes holding low-value versus the rail plan.',
      criteria: {
        true: 'Decay or a short life makes holding low-value',
        false: 'Time is not the reason to act',
      },
    },
  };
}

function numOrNull(v: unknown): number | null {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export function parseJevExitPanel(answers: Record<string, any> | undefined | null): JevExitPanel {
  const a = answers || {};
  const action = a.action || a.jev_exit;
  return {
    thesis_intact: numOrNull(a.thesis_intact?.noul),
    action: action
      ? { choice: parseJevExitPick(action.choice), confidence: numOrNull(action.confidence) }
      : null,
    giveback_risk: a.giveback_risk
      ? { score: numOrNull(a.giveback_risk.score), confidence: numOrNull(a.giveback_risk.confidence) }
      : null,
    time_pressure: numOrNull(a.time_pressure?.noul),
  };
}

export function composeJevExit(panel: JevExitPanel, mode: 'shadow' | 'active'): {
  pick: JevExitPick;
  opinion: JevExitPick;
  failOpen: boolean;
  because: string;
} {
  const opinion = parseJevExitPick(panel.action?.choice) ?? 'hold';
  if (mode !== 'active') {
    return { pick: 'hold', opinion, failOpen: true, because: 'jev shadow: logged, exit rails kept' };
  }
  const conf = panel.action?.confidence;
  if (conf == null || conf < EXIT_CONF_MIN) {
    const shown = conf == null ? 'missing' : conf.toFixed(2);
    return {
      pick: 'hold',
      opinion,
      failOpen: false,
      because: `choice confidence ${shown} is below ${EXIT_CONF_MIN}, so hold. Rails stay on.`,
    };
  }
  if (opinion === 'exit' && conf >= 0.70) {
    return { pick: 'exit', opinion, failOpen: false, because: `CLOSE (c=${conf.toFixed(2)})` };
  }
  if (opinion === 'partial' && conf >= 0.70) {
    return { pick: 'partial', opinion, failOpen: false, because: `PARTIAL (c=${conf.toFixed(2)}). Sell only, never add.` };
  }
  if (opinion === 'tighten' && conf >= 0.70) {
    return { pick: 'tighten', opinion, failOpen: false, because: `TIGHTEN_TRAIL (c=${conf.toFixed(2)})` };
  }
  return { pick: 'hold', opinion, failOpen: false, because: `jev hold (c=${conf.toFixed(2)})` };
}

/** Local opinion used when we will not spend a TypeSafe call. Never applied by itself. */
export function localJevExitOpinion(input: { fav?: number | null; peak?: number | null; dte?: number | null; leaps?: boolean | null }): JevExitPick {
  const fav = Number(input.fav);
  const peak = Number(input.peak);
  const dte = input.dte;
  if (Number.isFinite(fav) && fav <= -8) return 'exit';
  if (Number.isFinite(peak) && peak >= 12 && Number.isFinite(fav) && fav <= peak - 6) return 'tighten';
  if (!input.leaps && dte != null && dte <= 1 && Number.isFinite(fav) && fav < 5) return 'tighten';
  return 'hold';
}

function holdGate(because: string, called: boolean, mode: 'shadow' | 'active', extra: Partial<JevExitGate> = {}): JevExitGate {
  const answer = choice({
    id: 'exit',
    options: JEV_EXIT_OPTIONS,
    pick: 'hold',
    because,
    evidence: { mode, failOpen: true },
  });
  return {
    pick: 'hold',
    opinion: extra.opinion ?? 'hold',
    confidence: 0,
    because,
    failOpen: true,
    called,
    applied: false,
    mode,
    skipped: extra.skipped ?? null,
    answer,
    panel: extra.panel,
  };
}

function exitState(input: JevExitInput): Record<string, unknown> {
  const base = buildJevState(input);
  return {
    ...base,
    monitor_id: input.monitor_id ?? null,
    occ: input.occ ?? null,
    fav_pct: input.fav ?? null,
    peak_pct: input.peak ?? null,
    trail_pct: input.trail_pct ?? null,
    sl_pct: input.sl_pct ?? null,
    entry_price: input.entry_price ?? null,
    last_price: input.last_price ?? null,
    qty: input.qty ?? null,
    leaps: input.leaps === true,
  };
}

type ExitReplay = {
  opinion: JevExitPick;
  appliedExit: boolean;
  appliedPick?: 'exit' | 'partial';
  because: string;
};

export async function jevExitGate(input: JevExitInput, deps: {
  client?: JevClient;
  apiKey?: string | null;
  paper?: boolean;
  mode?: JevUiMode | string | null;
  model?: string | null;
  botFlags?: JevBotFlags;
  /** Regular-hours gate. Undefined does not block (unit tests). False skips TypeSafe and sell replays. */
  rth?: boolean;
  minutesToClose?: number | null;
  now?: number;
  log?: (file: string, line: string) => Promise<void>;
  logPath?: string;
  budgetIo?: JevBudgetIo;
} = {}): Promise<JevExitGate> {
  let ui: JevUiMode;
  if (deps.mode != null) ui = parseJevUiMode(deps.mode);
  else {
    const s = await loadJevSettings().catch(() => ({ enabled: true, mode: parseJevUiMode(config.typesafe.entryMode) }));
    ui = effectiveJevMode(s);
  }
  const explicit = deps.botFlags != null || input.bot_id != null;
  const flags = deps.botFlags ?? { entry: false, exit: false };
  const eff: JevEffective = jevEffective({
    global: ui,
    flags,
    kind: 'exit',
    legacyOpen: !explicit,
    paper: deps.paper,
  });
  const dteNum = parseJevDte(input.dte ?? input.dte_or_leaps);
  const leaps = input.leaps === true || (typeof input.dte_or_leaps === 'string' && /leaps/i.test(input.dte_or_leaps)) || (dteNum != null && dteNum >= 180);
  const key = jevCadenceKey('exit', {
    botId: input.bot_id,
    symbol: input.symbol,
    occ: input.occ,
    monitorId: input.monitor_id,
  });
  const now = deps.now ?? Date.now();
  const windowMs = jevExitCadenceWindowMs({ dte: dteNum, leaps, minutesToClose: deps.minutesToClose });
  const fresh = takeFreshCadence<ExitReplay>(key, now, windowMs);
  if (fresh && eff.reason !== 'global_off') {
    const replaySell = fresh.appliedExit && eff.apply && deps.rth !== false;
    if (replaySell) {
      const pick: JevExitPick = fresh.appliedPick === 'partial' ? 'partial' : 'exit';
      const because = `cadence: replay ${pick} without a new TypeSafe call (${Math.round(windowMs / 60000)} min)`;
      const answer = choice({
        id: 'exit',
        options: JEV_EXIT_OPTIONS,
        pick,
        because,
        evidence: { cadence: true },
      });
      return {
        pick,
        opinion: pick,
        confidence: 0,
        because,
        failOpen: false,
        called: false,
        applied: true,
        mode: 'active',
        skipped: 'cadence',
        answer,
      };
    }
    return holdGate(
      `cadence: last exit decision is still fresh (${Math.round(windowMs / 60000)} min)`,
      false,
      eff.mode,
      { skipped: 'cadence', opinion: fresh.opinion },
    );
  }

  if (eff.reason === 'global_off') {
    return holdGate('jev off: TypeSafe not called, exit rails kept', false, 'shadow', { skipped: 'global_off' });
  }

  const opinionIfLocal = localJevExitOpinion({ fav: input.fav, peak: input.peak, dte: dteNum, leaps });

  const logLocal = async (skipped: string, because: string) => {
    const gate = holdGate(because, false, 'shadow', { skipped, opinion: opinionIfLocal });
    await appendJevJsonl({
      ts: new Date(now).toISOString(),
      event: 'jev.exit',
      kind: 'exit',
      mode: 'shadow',
      pick: opinionIfLocal,
      acted: 'hold',
      applied: false,
      called: false,
      skipped,
      because,
      symbol: input.symbol,
      bot: input.bot_name || input.bot || null,
      per_bot: flags,
      state: exitState(input),
    }, deps.logPath, deps.log);
    rememberCadence(key, now, { opinion: opinionIfLocal, appliedExit: false, because } satisfies ExitReplay);
    return gate;
  };

  if (!eff.call) {
    const because = eff.reason === 'paper_only'
      ? 'Jev exit stays on Alpaca paper: logged, not acted'
      : 'per-bot jev exit is off: decision logged, position not changed';
    return logLocal(eff.reason, because);
  }

  if (deps.rth === false) {
    return logLocal('rth_closed', 'Jev exit checks run in regular hours. Rails stay on.');
  }

  const spend = await loadJevSpend(deps.budgetIo);
  if (!canCallJevApi(spend)) {
    return logLocal('budget', 'Jev budget is spent: exit opinion logged, rails kept');
  }

  const resolved = await resolveJevClient({ client: deps.client, apiKey: deps.apiKey ?? typesafeApiKey() });
  if (!resolved.client) {
    return logLocal('no_key', 'TYPESAFE_API_KEY unset: exit opinion logged, rails kept');
  }

  try {
    const state = exitState(input);
    const res = await resolved.client.systemOne({
      state,
      questions: jevExitQuestions(),
      model: jevModel(deps.model),
    });
    await recordJevUsage({ inputTokens: res?.usage?.input_tokens ?? 800, io: deps.budgetIo });
    const panel = parseJevExitPanel(res?.answers);
    const composed = composeJevExit(panel, eff.mode);
    const acted: JevExitPick = eff.apply ? composed.pick : 'hold';
    const because = eff.apply ? composed.because : `${composed.because} (not applied)`;
    const answer = choice({
      id: 'exit',
      options: JEV_EXIT_OPTIONS,
      pick: acted,
      because,
      evidence: { mode: eff.mode, apply: eff.apply, opinion: composed.opinion },
    });
    const gate: JevExitGate = {
      pick: acted,
      opinion: composed.opinion,
      confidence: panel.action?.confidence ?? 0,
      because,
      failOpen: !eff.apply || composed.failOpen,
      called: true,
      applied: eff.apply && acted !== 'hold',
      mode: eff.mode,
      skipped: eff.apply ? null : eff.reason,
      answer,
      panel,
    };
    await appendJevJsonl({
      ts: new Date(now).toISOString(),
      event: 'jev.exit',
      kind: 'exit',
      mode: eff.mode,
      model: res?.model || jevModel(deps.model),
      via: resolved.via,
      pick: composed.opinion,
      acted,
      applied: gate.applied,
      called: true,
      skipped: gate.skipped,
      failOpen: gate.failOpen,
      because: gate.because,
      symbol: state.symbol,
      bot: state.bot || state.bot_name || null,
      per_bot: flags,
      answers: res?.answers ?? null,
      usage: res?.usage ?? null,
      panel,
      state,
    }, deps.logPath, deps.log);
    rememberCadence(key, now, {
      opinion: composed.opinion,
      appliedExit: (acted === 'exit' || acted === 'partial') && eff.apply,
      appliedPick: acted === 'partial' ? 'partial' : 'exit',
      because: gate.because,
    } satisfies ExitReplay);
    return gate;
  } catch (e: any) {
    const msg = e?.message || String(e);
    const statusMatch = String(msg).match(/\b(401|402|429)\b/);
    const status = statusMatch ? Number(statusMatch[1]) : undefined;
    await recordJevUsage({ error: msg, status, io: deps.budgetIo });
    return logLocal('error', `Jev exit API error, rails kept: ${msg}`.slice(0, 240));
  }
}
