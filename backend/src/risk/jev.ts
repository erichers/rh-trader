/**
 * Optional live Jev / TypeSafe System One *panel* on fired bot entries.
 *
 * Deterministic rails stay in code (calls-only, DTE / LEAPS waiver, swing
 * law). Jev is a post-signal panel only — never an exit engine and never a
 * price predictor. One System One call per fired entry, four parallel
 * questions, compose in this file.
 *
 * Default `JEV_ENTRY_MODE=shadow`: log answers, always allow paper.
 * `active` applies composition. No key / API error → fail-open + log.
 * Never logs the API key. Exits / flatten never call this.
 */

import { appendFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { config } from '../config.js';
import { choice, type ChoiceAnswer } from './decide.js';
import {
  canCallJevApi,
  loadJevSpend,
  recordJevUsage,
  type JevBudgetIo,
} from './jevBudget.js';
import { fallbackJevGate } from './jevFallback.js';

export const JEV_MODEL_DEFAULT = 'jev-latest';
export const JEV_ENTRY_MODE_DEFAULT = 'shadow' as const;
export type JevEntryMode = 'shadow' | 'active';

export const JEV_CHOICE_ID = 'action';
export const JEV_OPTIONS = ['enter', 'skip', 'size_down'] as const;
export type JevEntryPick = (typeof JEV_OPTIONS)[number];

/** Active composition constants (single source of truth). */
export const JEV_COHERENT_MIN = 0.55;
export const JEV_SKIP_CONF_MIN = 0.70;
export const JEV_CHOICE_CONF_MIN = 0.75;
export const JEV_SETUP_SIZE_DOWN = 1.2;
export const JEV_SETUP_LEVELS = ['weak', 'ok', 'strong'] as const;

export type JevEntryState = {
  symbol: string;
  bot_id?: number | string | null;
  bot_name?: string | null;
  bot?: string | null;
  asset_class?: string | null;
  option_type?: string | null;
  expiration?: string | null;
  strike_target?: string | null;
  dte_or_leaps?: number | string | null;
  dte?: number | string | null;
  signal_why?: string | null;
  why?: string | null;
  checks?: unknown;
  est_premium?: number | null;
  premium?: number | null;
  equity?: number | null;
  open_positions_count?: number | null;
  mode?: string | null;
  source?: string | null;
};

export type JevAnswer = {
  type?: string;
  choice?: string;
  noul?: number;
  score?: number;
  confidence?: number;
  probabilities?: Record<string, number>;
};

export type JevClient = {
  systemOne(req: {
    state: unknown;
    questions: Record<string, unknown>;
    model?: string;
  }): Promise<{
    model?: string;
    answers?: Record<string, JevAnswer>;
    usage?: { input_tokens?: number; output_tokens?: number };
  }>;
};

export type JevPanelAnswers = {
  signal_coherent?: number | null;
  action?: { choice?: string | null; confidence?: number | null } | null;
  setup_quality?: { score?: number | null; confidence?: number | null } | null;
  too_crowded_same_day?: number | null;
};

export type JevCompose = {
  pick: JevEntryPick;
  failOpen: boolean;
  because: string;
};

export type JevGate = {
  pick: JevEntryPick;
  confidence: number;
  because: string;
  failOpen: boolean;
  called: boolean;
  mode: JevEntryMode;
  answer: ChoiceAnswer<JevEntryPick>;
  panel?: JevPanelAnswers;
};

const SYSTEMONE_PATH = '/v1/systemone';

export function typesafeApiKey(override?: string | null): string {
  return String(override ?? config.typesafe.apiKey ?? '').trim();
}

export function typesafeConfigured(override?: string | null): boolean {
  return typesafeApiKey(override).length > 0;
}

export function jevEntryMode(override?: string | null): JevEntryMode {
  const raw = String(override ?? config.typesafe.entryMode ?? JEV_ENTRY_MODE_DEFAULT).trim().toLowerCase();
  return raw === 'active' ? 'active' : 'shadow';
}

export function jevModel(override?: string | null): string {
  const raw = String(override ?? config.typesafe.model ?? '').trim();
  return raw || JEV_MODEL_DEFAULT;
}

function clip(v: unknown, n = 240): string | null {
  if (v == null) return null;
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  if (!s) return null;
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

function trimChecks(raw: unknown): Record<string, string> | null {
  if (raw == null) return null;
  if (typeof raw !== 'object') return { note: clip(raw, 120) || '' };
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (out && Object.keys(out).length >= 8) break;
    if (v && typeof v === 'object' && 'detail' in (v as object)) {
      out[k] = clip((v as { detail?: unknown }).detail, 80) || '';
    } else {
      out[k] = clip(v, 80) || '';
    }
  }
  return out;
}

/** Token-trimmed state blob sent to System One. */
export function buildJevState(input: JevEntryState): Record<string, unknown> {
  return {
    bot_id: input.bot_id ?? null,
    bot_name: clip(input.bot_name ?? input.bot, 80),
    symbol: String(input.symbol || '').toUpperCase(),
    asset_class: input.asset_class ?? null,
    option_type: input.option_type ?? null,
    expiration: input.expiration ?? null,
    strike_target: input.strike_target ?? null,
    dte_or_leaps: input.dte_or_leaps ?? input.dte ?? null,
    signal_why: clip(input.signal_why ?? input.why, 240),
    checks: trimChecks(input.checks),
    est_premium: input.est_premium ?? input.premium ?? null,
    equity: input.equity ?? null,
    open_positions_count: input.open_positions_count ?? null,
    mode: input.mode ?? null,
  };
}

/** Action Choice only (kept for tests / HTTP smoke). */
export function jevEntryQuestion() {
  return jevEntryQuestions().action;
}

export function jevEntryQuestions() {
  return {
    signal_coherent: {
      type: 'noul' as const,
      instructions: 'The bot checks and why agree this is a fresh momentum or RSI reclaim, not a stale or contradictory leftover state.',
      criteria: {
        true: 'Fresh trigger + filters agree (momentum / RSI reclaim)',
        false: 'Stale, already-true, or checks contradict why',
      },
    },
    action: {
      type: 'choice' as const,
      instructions: 'Should this Alpaca paper bot open a new long call? Rails already enforced in code: calls-only, 2–14 DTE for non-LEAPS, long-call LEAPS (≥180 DTE / far expiration) intentionally allowed, privileged 0–1 only on the allowlist. Puts and equity buys are blocked. This is a post-signal panel, not a price prediction and not an exit.',
      criteria: {
        enter: 'Coherent fresh setup of at least ok quality — take the proposed size',
        skip: 'Do not enter: stale/contradictory signal, crowded same-day add, or weak setup',
        size_down: 'Enter but cut size (half qty, min 1): setup is only ok/weak or another add today is low-value',
      },
    },
    setup_quality: {
      type: 'score' as const,
      instructions: 'Trend plus trigger quality for this long-call entry. Not a price forecast.',
      criteria: [...JEV_SETUP_LEVELS],
    },
    too_crowded_same_day: {
      type: 'noul' as const,
      instructions: 'Another add in this symbol today is low-value given current activity.',
      criteria: {
        true: 'Same-symbol add today is crowded / low-value',
        false: 'This add is still incremental',
      },
    },
  };
}

export function parseJevPick(raw: unknown): JevEntryPick | null {
  const s = String(raw || '').toLowerCase().replace(/-/g, '_');
  if (s === 'enter' || s === 'skip' || s === 'size_down' || s === 'sizedown') {
    return s === 'sizedown' ? 'size_down' : (s as JevEntryPick);
  }
  return null;
}

export function applyJevSizeDown(qty: number): number {
  const n = Number(qty);
  if (!Number.isFinite(n) || n <= 1) return 1;
  return Math.max(1, Math.floor(n / 2));
}

function numOrNull(v: unknown): number | null {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export function parseJevPanel(answers: Record<string, JevAnswer> | undefined | null): JevPanelAnswers {
  const a = answers || {};
  const action = a.action || a.jev_entry;
  return {
    signal_coherent: numOrNull(a.signal_coherent?.noul),
    action: action
      ? { choice: parseJevPick(action.choice), confidence: numOrNull(action.confidence) }
      : null,
    setup_quality: a.setup_quality
      ? { score: numOrNull(a.setup_quality.score), confidence: numOrNull(a.setup_quality.confidence) }
      : null,
    too_crowded_same_day: numOrNull(a.too_crowded_same_day?.noul),
  };
}

/**
 * Compose panel answers into enter | skip | size_down.
 * Shadow always allows (fail-open). Active:
 *   skip if coherent<0.55 OR (action=skip && conf≥0.70)
 *   size_down if action=size_down OR setup_quality<1.2
 *   else enter
 *   Choice conf<0.75 → fail-open even in active
 */
export function composeJevEntry(panel: JevPanelAnswers, mode: JevEntryMode = 'shadow'): JevCompose {
  if (mode !== 'active') {
    return { pick: 'enter', failOpen: true, because: 'jev shadow — logged, paper allowed' };
  }
  const actionConf = panel.action?.confidence;
  const actionPick = parseJevPick(panel.action?.choice);
  if (actionConf == null || actionConf < JEV_CHOICE_CONF_MIN) {
    const shown = actionConf == null ? 'missing' : actionConf.toFixed(2);
    return {
      pick: 'enter',
      failOpen: true,
      because: `jev choice conf ${shown} < ${JEV_CHOICE_CONF_MIN} — fail-open even in active`,
    };
  }
  const coherent = panel.signal_coherent;
  if (coherent != null && coherent < JEV_COHERENT_MIN) {
    return {
      pick: 'skip',
      failOpen: false,
      because: `signal_coherent ${coherent.toFixed(2)} < ${JEV_COHERENT_MIN}`,
    };
  }
  if (actionPick === 'skip' && actionConf >= JEV_SKIP_CONF_MIN) {
    return {
      pick: 'skip',
      failOpen: false,
      because: `jev skip (c=${actionConf.toFixed(2)} ≥ ${JEV_SKIP_CONF_MIN})`,
    };
  }
  const quality = panel.setup_quality?.score;
  if (actionPick === 'size_down' || (quality != null && quality < JEV_SETUP_SIZE_DOWN)) {
    const why = actionPick === 'size_down'
      ? `jev size_down (c=${actionConf.toFixed(2)})`
      : `setup_quality ${quality!.toFixed(2)} < ${JEV_SETUP_SIZE_DOWN}`;
    return { pick: 'size_down', failOpen: false, because: why };
  }
  return {
    pick: 'enter',
    failOpen: false,
    because: `jev enter (c=${actionConf.toFixed(2)})`,
  };
}

/** HTTP System One client (no SDK required). Injectable fetch for tests. */
export function httpJevClient(opts: {
  apiKey: string;
  baseUrl?: string;
  model?: string;
  fetchFn?: typeof fetch;
  timeoutMs?: number;
}): JevClient {
  const base = String(opts.baseUrl || config.typesafe.baseUrl || 'https://api.typesafe.ai').replace(/\/$/, '');
  const model = jevModel(opts.model);
  const fetchFn = opts.fetchFn || fetch;
  const timeoutMs = opts.timeoutMs ?? 8_000;
  return {
    async systemOne(req) {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), timeoutMs);
      try {
        const res = await fetchFn(`${base}${SYSTEMONE_PATH}`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${opts.apiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            model: req.model || model,
            state: req.state,
            questions: req.questions,
          }),
          signal: ctrl.signal,
        });
        const text = await res.text();
        if (!res.ok) throw new Error(`typesafe ${res.status}: ${text.slice(0, 180)}`);
        return JSON.parse(text);
      } finally {
        clearTimeout(t);
      }
    },
  };
}

async function resolveClient(opts: {
  client?: JevClient;
  apiKey?: string | null;
}): Promise<{ client: JevClient | null; apiKey: string; via: 'inject' | 'sdk' | 'http' | 'none' }> {
  if (opts.client) return { client: opts.client, apiKey: typesafeApiKey(opts.apiKey), via: 'inject' };
  const apiKey = typesafeApiKey(opts.apiKey);
  if (!apiKey) return { client: null, apiKey: '', via: 'none' };
  try {
    const sdkName = '@typesafe-ai/sdk';
    const mod: any = await import(sdkName);
    const Ctor = mod.TypeSafeClient || mod.default;
    if (typeof Ctor === 'function') {
      return { client: new Ctor({ apiKey, baseURL: config.typesafe.baseUrl }), apiKey, via: 'sdk' };
    }
  } catch {
    // SDK optional — HTTP POST is the supported fallback.
  }
  return {
    client: httpJevClient({ apiKey, baseUrl: config.typesafe.baseUrl, model: jevModel() }),
    apiKey,
    via: 'http',
  };
}

function failOpenGate(because: string, called: boolean, mode: JevEntryMode): JevGate {
  const answer = choice({
    id: JEV_CHOICE_ID,
    options: JEV_OPTIONS,
    pick: 'enter',
    because,
    evidence: { failOpen: true, mode },
  });
  return { pick: 'enter', confidence: 0, because, failOpen: true, called, mode, answer };
}

export async function appendJevJsonl(
  rec: Record<string, unknown>,
  path = config.typesafe.logPath,
  write?: (file: string, line: string) => Promise<void>,
): Promise<void> {
  try {
    const line = `${JSON.stringify(rec)}\n`;
    if (write) {
      await write(path, line);
      return;
    }
    await mkdir(dirname(path), { recursive: true });
    await appendFile(path, line, 'utf8');
  } catch {
    // Logging must never block an entry.
  }
}

/**
 * Ask Jev whether to enter. Never throws.
 * Shadow (default) and missing-key / errors fail-open.
 * `side` other than buy short-circuits without a network call.
 */
export async function jevEntryGate(input: JevEntryState & {
  side?: string | null;
  source?: string | null;
}, deps: {
  client?: JevClient;
  apiKey?: string | null;
  paper?: boolean;
  mode?: JevEntryMode | string | null;
  model?: string | null;
  log?: (file: string, line: string) => Promise<void>;
  logPath?: string;
  budgetIo?: JevBudgetIo;
  llmReview?: (system: string, user: string) => Promise<{ go?: boolean; because?: string }>;
} = {}): Promise<JevGate> {
  const side = String(input.side || 'buy').toLowerCase();
  const source = String(input.source || 'bot').toLowerCase();
  const mode = jevEntryMode(deps.mode);
  if (side !== 'buy') return failOpenGate('jev not asked — exit/flatten stays deterministic', false, mode);
  if (source !== 'bot' && source !== 'ai') return failOpenGate('jev not asked — not a bot/ai entry', false, mode);

  const spend = await loadJevSpend(deps.budgetIo);
  if (!canCallJevApi(spend)) {
    const fb = await fallbackJevGate(input, mode, { llmReview: deps.llmReview });
    const gate = failOpenGate(fb.because, false, mode);
    const out: JevGate = {
      ...gate,
      pick: mode === 'shadow' ? 'enter' : fb.pick,
      failOpen: fb.failOpen,
      because: fb.because,
      panel: fb.panel,
    };
    await appendJevJsonl({
      ts: new Date().toISOString(),
      event: 'jev.fallback',
      mode,
      degraded: true,
      reason: spend.reason,
      pick: out.pick,
      failOpen: out.failOpen,
      because: out.because,
      via: fb.via,
      state: buildJevState(input),
    }, deps.logPath, deps.log);
    return out;
  }

  const resolved = await resolveClient(deps);
  if (!resolved.client) {
    const gate = failOpenGate('TYPESAFE_API_KEY unset — paper fail-open, entry allowed', false, mode);
    await appendJevJsonl({
      ts: new Date().toISOString(),
      event: 'jev.entry',
      mode,
      failOpen: true,
      pick: 'enter',
      because: gate.because,
      called: false,
      state: buildJevState(input),
    }, deps.logPath, deps.log);
    return gate;
  }

  try {
    const state = buildJevState(input);
    const questions = jevEntryQuestions();
    const res = await resolved.client.systemOne({
      state,
      questions,
      model: jevModel(deps.model),
    });
    await recordJevUsage({ inputTokens: res?.usage?.input_tokens ?? 800, io: deps.budgetIo });
    const panel = parseJevPanel(res?.answers);
    const composed = composeJevEntry(panel, mode);
    const actionConf = panel.action?.confidence;
    const because = composed.because;
    const answer = choice({
      id: JEV_CHOICE_ID,
      options: JEV_OPTIONS,
      pick: composed.pick,
      mass: (res?.answers?.action?.probabilities || {}) as Partial<Record<JevEntryPick, number>>,
      because,
      evidence: {
        symbol: state.symbol as string,
        dte_or_leaps: state.dte_or_leaps as string | number | null,
        via: resolved.via,
        mode,
        failOpen: composed.failOpen,
      },
    });
    const gate: JevGate = {
      pick: composed.pick,
      confidence: actionConf ?? answer.confidence,
      because,
      failOpen: composed.failOpen,
      called: true,
      mode,
      answer,
      panel,
    };
    await appendJevJsonl({
      ts: new Date().toISOString(),
      event: 'jev.entry',
      mode,
      model: res?.model || jevModel(deps.model),
      via: resolved.via,
      pick: gate.pick,
      failOpen: gate.failOpen,
      because: gate.because,
      called: true,
      answers: res?.answers ?? null,
      usage: res?.usage ?? null,
      panel,
      state,
    }, deps.logPath, deps.log);
    return gate;
  } catch (e: any) {
    const msg = e?.message || String(e);
    const statusMatch = String(msg).match(/\b(401|402|429)\b/);
    const status = statusMatch ? Number(statusMatch[1]) : undefined;
    await recordJevUsage({ error: msg, status, io: deps.budgetIo });
    const because = `jev error — fail-open: ${msg}`.slice(0, 240);
    const gate = failOpenGate(because, true, mode);
    await appendJevJsonl({
      ts: new Date().toISOString(),
      event: 'jev.entry',
      mode,
      failOpen: true,
      pick: 'enter',
      because,
      called: true,
      error: msg.slice(0, 240),
      state: buildJevState(input),
    }, deps.logPath, deps.log);
    return gate;
  }
}
