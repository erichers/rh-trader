/**
 * Muse live watcher — observe-only cycle over open positions + armed bots.
 *
 * Never places, stages, or vetoes an order. Health lamp is never green when
 * Muse is unconfigured or the last cycle failed ("unknown, not green").
 */

import { config } from '../config.js';
import { audit, getTradingEnv, q } from '../db.js';
import { isObserveOnlyBot } from '../risk/observe.js';

export type MuseWatchLamp = {
  available: boolean;
  observeOnly: true;
  running: boolean;
  lastCycle: string | null;
  lastError: string | null;
  ok: boolean;
  note: string;
  positions?: number;
  armedBots?: number;
};

export type MuseWatchCycle = {
  at: string;
  env: string;
  positions: number;
  armedBots: number;
  symbols: string[];
  error: string | null;
};

const UNKNOWN_NOTE = 'Muse watcher is optional. If this API is down, treat watch as unknown — never green.';

let running = false;
let lastCycle: MuseWatchCycle | null = null;
let lastError: string | null = null;

export function museConfigured(override?: { apiKey?: string | null }): boolean {
  const key = String(override?.apiKey ?? config.muse.apiKey ?? '').trim();
  return key.length > 0;
}

/** Pure lamp. Never green when Muse is down / unconfigured / last cycle errored. */
export function museWatchLamp(input: {
  configured: boolean;
  running: boolean;
  lastCycle: string | null;
  lastError: string | null;
  positions?: number;
  armedBots?: number;
}): MuseWatchLamp {
  const observeOnly = true as const;
  if (!input.configured) {
    return {
      available: false,
      observeOnly,
      running: false,
      lastCycle: input.lastCycle,
      lastError: input.lastError || 'Muse not configured',
      ok: false,
      note: UNKNOWN_NOTE,
      positions: input.positions,
      armedBots: input.armedBots,
    };
  }
  if (input.lastError) {
    return {
      available: true,
      observeOnly,
      running: input.running,
      lastCycle: input.lastCycle,
      lastError: input.lastError,
      ok: false,
      note: 'Muse watcher error — treat watch as unknown, not green.',
      positions: input.positions,
      armedBots: input.armedBots,
    };
  }
  const ok = !!(input.running || input.lastCycle);
  return {
    available: true,
    observeOnly,
    running: input.running,
    lastCycle: input.lastCycle,
    lastError: null,
    ok,
    note: ok
      ? 'Muse observe-only watcher. Never places orders.'
      : 'Muse configured — waiting for first cycle (unknown, not green).',
    positions: input.positions,
    armedBots: input.armedBots,
  };
}

export function museWatchStatus(opts?: { apiKey?: string | null }): MuseWatchLamp {
  return museWatchLamp({
    configured: museConfigured(opts),
    running,
    lastCycle: lastCycle?.at ?? null,
    lastError,
    positions: lastCycle?.positions,
    armedBots: lastCycle?.armedBots,
  });
}

function parseJsonish(v: any): any {
  if (v == null) return {};
  if (typeof v === 'object') return v;
  try { return JSON.parse(String(v)); } catch { return {}; }
}

/** One observe-only pass. Injectable readers for tests. */
export async function runMuseWatchCycle(deps: {
  env?: string;
  loadPositions?: (env: string) => Promise<{ symbol: string }[]>;
  loadBots?: (env: string) => Promise<any[]>;
  now?: () => string;
} = {}): Promise<MuseWatchCycle> {
  if (running) {
    return lastCycle || { at: new Date().toISOString(), env: 'unknown', positions: 0, armedBots: 0, symbols: [], error: 'already running' };
  }
  running = true;
  const at = deps.now ? deps.now() : new Date().toISOString();
  let env = deps.env || 'alpaca_paper';
  try {
    env = deps.env || await getTradingEnv();
    const positions = deps.loadPositions
      ? await deps.loadPositions(env)
      : await q<{ symbol: string }>(
        'SELECT symbol FROM positions WHERE env=:env AND ABS(qty) > 0 ORDER BY updated_at DESC LIMIT 80',
        { env },
      );
    const bots = deps.loadBots
      ? await deps.loadBots(env)
      : await q<any>('SELECT id, name, enabled, mode, action, rules, risk FROM bots WHERE env=:env AND enabled=1', { env });
    const armed = (bots || []).filter((b) => {
      if (isObserveOnlyBot(b)) return false;
      const mode = String(b.mode || parseJsonish(b.action)?.mode || '');
      return mode === 'auto' || mode === 'full_auto' || mode === 'cautious';
    });
    const symbols = [...new Set([
      ...positions.map((p) => String(p.symbol || '').toUpperCase()).filter(Boolean),
      ...armed.map((b) => String(b.name || '').slice(0, 40)),
    ])].slice(0, 40);
    lastError = null;
    lastCycle = {
      at,
      env,
      positions: positions.length,
      armedBots: armed.length,
      symbols,
      error: null,
    };
    await audit('muse.watch', `positions=${positions.length} armed=${armed.length}`, {
      env, positions: positions.length, armed: armed.length, observe_only: true,
    }).catch(() => {});
    return lastCycle;
  } catch (e: any) {
    const msg = String(e?.message || e).slice(0, 240);
    lastError = msg;
    lastCycle = { at, env, positions: 0, armedBots: 0, symbols: [], error: msg };
    await audit('muse.watch.error', msg, { observe_only: true }).catch(() => {});
    return lastCycle;
  } finally {
    running = false;
  }
}

/** Test helper — reset process lamp state. */
export function resetMuseWatchForTests(): void {
  running = false;
  lastCycle = null;
  lastError = null;
}
