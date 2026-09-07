import { isConfigured, providerStatus, sanitizeError, type ProviderName, type Task } from './models.js';

/** In-memory LLM + watcher activity. Polled by the dashboard. Never holds secrets. */

export type ActivityPhase = 'start' | 'ok' | 'error';

export type ActivityEvent = {
  at: string;
  provider: ProviderName | string;
  task: Task | string;
  model: string | null;
  phase: ActivityPhase;
  detail: string | null;
};

export type MuseNow = {
  task: string;
  model: string | null;
  startedAt: string;
  detail: string | null;
} | null;

const RECENT_CAP = 24;
const ERROR_CAP = 12;

const recent: ActivityEvent[] = [];
const errors: ActivityEvent[] = [];
let museNow: MuseNow = null;

function iso(ms = Date.now()): string {
  return new Date(ms).toISOString();
}

/** Record a cascade attempt. Safe to call from llm.ts. Never throws. */
export function recordLlmCall(a: {
  provider: ProviderName | string;
  task: Task | string;
  model?: string | null;
  phase: ActivityPhase;
  detail?: string | null;
}): void {
  const ev: ActivityEvent = {
    at: iso(),
    provider: a.provider,
    task: a.task,
    model: a.model || null,
    phase: a.phase,
    detail: sanitizeError(a.detail),
  };
  recent.unshift(ev);
  if (recent.length > RECENT_CAP) recent.length = RECENT_CAP;
  if (a.phase === 'error') {
    errors.unshift(ev);
    if (errors.length > ERROR_CAP) errors.length = ERROR_CAP;
  }
  if (a.provider === 'muse') {
    if (a.phase === 'start') {
      museNow = { task: String(a.task), model: a.model || null, startedAt: ev.at, detail: ev.detail };
    } else {
      // ok or error ends the current call (TS narrows phase away from 'start' here)
      museNow = null;
    }
  }
}

export function museActivity(): {
  configured: boolean;
  live: boolean | null;
  model: string;
  lastProbeAt: string | null;
  error: string | null;
  current: MuseNow;
  recent: ActivityEvent[];
  errors: ActivityEvent[];
} {
  const st = providerStatus().muse;
  return {
    configured: isConfigured('muse'),
    live: st?.live ?? null,
    model: st?.defaultModel || 'muse-spark-1.3',
    lastProbeAt: st?.lastProbeAt ?? null,
    error: st?.error ?? null,
    current: museNow,
    recent: recent.filter((e) => e.provider === 'muse').slice(0, 12),
    errors: errors.filter((e) => e.provider === 'muse').slice(0, 8),
  };
}

export function recentActivity(limit = 12): ActivityEvent[] {
  return recent.slice(0, Math.max(1, Math.min(RECENT_CAP, limit)));
}
