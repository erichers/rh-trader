/**
 * Optional live Jev / TypeSafe System One gate on fired bot entries.
 *
 * Pattern: one Choice — enter | skip | size_down — over a short state blob
 * (symbol, bot, why, DTE, premium). Exits / flatten never call this.
 *
 * Fail-open on paper: no TYPESAFE_API_KEY, HTTP/SDK error, or a malformed
 * answer → allow the entry and log. A real `skip` from Jev still vetoes.
 * Never logs the API key.
 */

import { config } from '../config.js';
import { choice, type ChoiceAnswer } from './decide.js';

export const JEV_CHOICE_ID = 'jev_entry';
export const JEV_OPTIONS = ['enter', 'skip', 'size_down'] as const;
export type JevEntryPick = (typeof JEV_OPTIONS)[number];

export type JevEntryState = {
  symbol: string;
  bot?: string | null;
  why?: string | null;
  dte?: number | string | null;
  premium?: number | null;
  source?: string | null;
};

export type JevClient = {
  systemOne(req: {
    state: unknown;
    questions: Record<string, unknown>;
    model?: string;
  }): Promise<{
    answers?: Record<string, { type?: string; choice?: string; confidence?: number; probabilities?: Record<string, number> }>;
  }>;
};

export type JevGate = {
  pick: JevEntryPick;
  confidence: number;
  because: string;
  failOpen: boolean;
  called: boolean;
  answer: ChoiceAnswer<JevEntryPick>;
};

const SYSTEMONE_PATH = '/v1/systemone';

export function typesafeApiKey(override?: string | null): string {
  return String(override ?? config.typesafe.apiKey ?? '').trim();
}

export function typesafeConfigured(override?: string | null): boolean {
  return typesafeApiKey(override).length > 0;
}

export function jevEntryQuestion() {
  return {
    type: 'choice' as const,
    instructions: 'Should this Alpaca paper bot open a new long call? 2–14 DTE is the fleet window; long-call LEAPS (≥180 DTE / far expiration) are intentionally allowed. Privileged short-DTE 0–1 only on the allowlist. Puts and equity buys are blocked.',
    criteria: {
      enter: 'Take the trade at the proposed size',
      skip: 'Do not enter — skip this signal',
      size_down: 'Enter but cut size (half qty, minimum 1 contract)',
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

/** HTTP System One client (no SDK required). Injectable fetch for tests. */
export function httpJevClient(opts: {
  apiKey: string;
  baseUrl?: string;
  model?: string;
  fetchFn?: typeof fetch;
  timeoutMs?: number;
}): JevClient {
  const base = String(opts.baseUrl || config.typesafe.baseUrl || 'https://api.typesafe.ai').replace(/\/$/, '');
  const model = opts.model || config.typesafe.model || 'jev-latest';
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
    client: httpJevClient({ apiKey, baseUrl: config.typesafe.baseUrl, model: config.typesafe.model }),
    apiKey,
    via: 'http',
  };
}

function failOpenGate(because: string, called: boolean): JevGate {
  const answer = choice({
    id: JEV_CHOICE_ID,
    options: JEV_OPTIONS,
    pick: 'enter',
    because,
    evidence: { failOpen: true },
  });
  return { pick: 'enter', confidence: 0, because, failOpen: true, called, answer };
}

/**
 * Ask Jev whether to enter. Never throws. Paper fail-open without a key or on error.
 * `side` other than buy (or missing source) short-circuits without a network call.
 */
export async function jevEntryGate(input: JevEntryState & {
  side?: string | null;
  source?: string | null;
}, deps: {
  client?: JevClient;
  apiKey?: string | null;
  paper?: boolean;
} = {}): Promise<JevGate> {
  const side = String(input.side || 'buy').toLowerCase();
  const source = String(input.source || 'bot').toLowerCase();
  if (side !== 'buy') return failOpenGate('jev not asked — exit/flatten stays deterministic', false);
  if (source !== 'bot' && source !== 'ai') return failOpenGate('jev not asked — not a bot/ai entry', false);

  const paper = deps.paper !== false;
  const resolved = await resolveClient(deps);
  if (!resolved.client) {
    return failOpenGate('TYPESAFE_API_KEY unset — paper fail-open, entry allowed', false);
  }

  try {
    const state = {
      symbol: String(input.symbol || '').toUpperCase(),
      bot: input.bot || null,
      why: input.why || null,
      dte: input.dte ?? null,
      premium_estimate: input.premium ?? null,
      desk: 'alpaca_paper',
      rails: 'calls-only; non-LEAPS 2-14 DTE; long-call LEAPS eligible; swing law 10/10/0/20/10',
    };
    const res = await resolved.client.systemOne({
      state,
      questions: { [JEV_CHOICE_ID]: jevEntryQuestion() },
    });
    const raw = res?.answers?.[JEV_CHOICE_ID];
    const pick = parseJevPick(raw?.choice);
    if (!pick) {
      return failOpenGate(`jev malformed answer — paper fail-open (${resolved.via})`, true);
    }
    const conf = Number(raw?.confidence);
    const because = `jev ${pick} (${resolved.via}${Number.isFinite(conf) ? `, c=${conf.toFixed(2)}` : ''})`;
    const answer = choice({
      id: JEV_CHOICE_ID,
      options: JEV_OPTIONS,
      pick,
      mass: (raw?.probabilities || {}) as Partial<Record<JevEntryPick, number>>,
      because,
      evidence: { symbol: state.symbol, dte: state.dte, via: resolved.via },
    });
    return {
      pick,
      confidence: Number.isFinite(conf) ? conf : answer.confidence,
      because,
      failOpen: false,
      called: true,
      answer,
    };
  } catch (e: any) {
    const msg = e?.message || String(e);
    if (!paper) {
      const because = `jev error — fail-closed off paper: ${msg}`.slice(0, 240);
      const answer = choice({
        id: JEV_CHOICE_ID, options: JEV_OPTIONS, pick: 'skip', because, evidence: { failOpen: false },
      });
      return { pick: 'skip', confidence: 0, because, failOpen: false, called: true, answer };
    }
    return failOpenGate(`jev error — paper fail-open: ${msg}`.slice(0, 240), true);
  }
}
