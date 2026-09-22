/**
 * Local Choice gate for expensive desk work.
 *
 * Mirrors the usage-lab router semantics (shadow default, skip / do / escalate)
 * with the TypeSafe Choice helper already on the desk. It does not SSH to the
 * box. If USAGE_ROUTER_URL is set, a POST may supply the choice. A bad response
 * falls back to this gate.
 *
 * Posts, spend, and protective sell retries are never gated. Shadow logs the
 * choice and still runs the work. Active may skip a wake or compute lane.
 * Jev exit and the hard stop are not this gate.
 */

import { choice, type ChoiceAnswer } from './decide.js';
import { config } from '../config.js';

export const USAGE_OPTIONS = ['skip', 'do', 'escalate'] as const;
export type UsagePick = (typeof USAGE_OPTIONS)[number];
export type UsageMode = 'shadow' | 'active';
export type UsageLane = 'compute' | 'wake' | 'retry' | 'post' | 'spend';

export type UsageInput = {
  lane: UsageLane;
  label: string;
  marketOpen?: boolean | null;
  openPositions?: number | null;
  recentSame?: boolean;
  failures?: number | null;
  material?: boolean;
  mode?: UsageMode;
};

export type UsageRoute = {
  lane: UsageLane;
  label: string;
  mode: UsageMode;
  choice: UsagePick;
  confidence: number;
  because: string;
  /** True when active mode actually skipped the work. */
  applied: boolean;
  /** False only when active mode skips a compute or wake lane. */
  proceed: boolean;
  via: 'local' | 'http';
  at: string;
};

const UNGATED = new Set<UsageLane>(['post', 'spend', 'retry']);

export function usageMode(explicit?: UsageMode): UsageMode {
  if (explicit === 'active' || explicit === 'shadow') return explicit;
  return config.usage.mode === 'active' ? 'active' : 'shadow';
}

export function isUngatedLane(lane: UsageLane): boolean {
  return UNGATED.has(lane);
}

/** Closed Choice. Posts and spend always pick do. */
export function usageChoice(input: UsageInput): ChoiceAnswer<UsagePick> {
  if (isUngatedLane(input.lane)) {
    return choice({
      id: 'usage',
      options: USAGE_OPTIONS,
      pick: 'do',
      because: 'posts and spend are never gated',
      evidence: { lane: input.lane, label: input.label },
    });
  }
  const failures = Number(input.failures) || 0;
  const open = Number(input.openPositions) || 0;
  const material = input.material === true;
  let pick: UsagePick = 'do';
  let because = 'ordinary wake, do the work';
  if (input.recentSame) {
    pick = 'skip';
    because = 'same lane ran recently';
  } else if (failures >= 3 && !material) {
    pick = 'skip';
    because = 'repeated failures and nothing material is open';
  } else if (input.marketOpen === false && !material) {
    pick = 'skip';
    because = 'market is closed and the lane is not material';
  } else if (material && open > 0) {
    pick = 'escalate';
    because = 'open paper positions make this wake worth the call';
  }
  return choice({
    id: 'usage',
    options: USAGE_OPTIONS,
    pick,
    because,
    evidence: {
      lane: input.lane,
      label: input.label,
      marketOpen: input.marketOpen ?? null,
      failures,
      material,
    },
  });
}

export function finishUsage(input: UsageInput, answer: ChoiceAnswer<UsagePick>, via: 'local' | 'http'): UsageRoute {
  const mode = usageMode(input.mode);
  const ungated = isUngatedLane(input.lane);
  const choicePick: UsagePick = ungated ? 'do' : answer.choice;
  const because = ungated ? 'posts and spend are never gated' : answer.because;
  const skip = !ungated && mode === 'active' && choicePick === 'skip';
  return {
    lane: input.lane,
    label: input.label,
    mode,
    choice: choicePick,
    confidence: answer.confidence,
    because,
    applied: skip,
    proceed: !skip,
    via: ungated ? 'local' : via,
    at: new Date().toISOString(),
  };
}

const log: UsageRoute[] = [];
const LOG_MAX = 20;

export function noteUsage(route: UsageRoute): void {
  log.unshift(route);
  if (log.length > LOG_MAX) log.length = LOG_MAX;
}

export function usageLog(): UsageRoute[] {
  return log.slice();
}

export function resetUsageLogForTests(): void {
  log.length = 0;
}

export function usageRouterSync(input: UsageInput): UsageRoute {
  const route = finishUsage(input, usageChoice(input), 'local');
  noteUsage(route);
  return route;
}

async function httpChoice(input: UsageInput): Promise<ChoiceAnswer<UsagePick> | null> {
  const url = String(config.usage.url || '').trim();
  if (!url || isUngatedLane(input.lane)) return null;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 1500);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        lane: input.lane,
        label: input.label,
        marketOpen: input.marketOpen ?? null,
        openPositions: input.openPositions ?? null,
        recentSame: !!input.recentSame,
        failures: Number(input.failures) || 0,
        material: !!input.material,
      }),
      signal: ctrl.signal,
    });
    if (!res.ok) return null;
    const body = await res.json() as { choice?: string };
    const pick = body?.choice;
    if (pick !== 'skip' && pick !== 'do' && pick !== 'escalate') return null;
    return choice({
      id: 'usage',
      options: USAGE_OPTIONS,
      pick,
      because: `usage router http chose ${pick}`,
      evidence: { lane: input.lane, label: input.label },
    });
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Optional HTTP, then the local Choice. Never throws. Never blocks a post. */
export async function usageRouter(input: UsageInput): Promise<UsageRoute> {
  if (isUngatedLane(input.lane)) return usageRouterSync(input);
  const remote = await httpChoice(input);
  const route = finishUsage(input, remote || usageChoice(input), remote ? 'http' : 'local');
  noteUsage(route);
  return route;
}

export function usagePublic(): {
  mode: UsageMode;
  http: boolean;
  note: string;
  last: UsageRoute | null;
} {
  return {
    mode: usageMode(),
    http: !!String(config.usage.url || '').trim(),
    note: 'Shadow is the default. The choice is skip, do, or escalate. Posts and spend are never gated.',
    last: log[0] || null,
  };
}
