/**
 * Muse live watcher — cycle over open positions + armed bots.
 * Never places. Mode `observe` is lamp-only. Mode `improve` (paper default)
 * applies local heuristic performance edits (SL/TP/trail / min_matches).
 */

import { config } from '../config.js';
import { audit, getTradingEnv, q } from '../db.js';
import { isObserveOnlyBot } from '../risk/observe.js';
import { cachedMuseMode, loadMuseSettings, type MuseUiMode } from './settings.js';
import { applyMuseImprove, formatMuseTune, museLastTune, type MuseLastTune } from './improve.js';

export type MuseWatchLamp = {
  available: boolean;
  observeOnly: boolean;
  mode: MuseUiMode;
  via: 'muse' | 'local';
  running: boolean;
  lastCycle: string | null;
  lastError: string | null;
  ok: boolean;
  note: string;
  positions?: number;
  armedBots?: number;
  lastTune?: MuseLastTune | null;
};

export type MuseWatchCycle = {
  at: string;
  env: string;
  positions: number;
  armedBots: number;
  symbols: string[];
  error: string | null;
  improved?: number;
};

const UNKNOWN_NOTE = 'Muse watcher is optional. If this API is down, treat watch as unknown — never green.';

let running = false;
let lastCycle: MuseWatchCycle | null = null;
let lastError: string | null = null;

export function museConfigured(override?: { apiKey?: string | null }): boolean {
  const key = String(override?.apiKey ?? config.muse.apiKey ?? '').trim();
  return key.length > 0;
}

/** Pure lamp. Observe+unconfigured stays unknown (never green). Improve+local may go green. */
export function museWatchLamp(input: {
  configured: boolean;
  running: boolean;
  lastCycle: string | null;
  lastError: string | null;
  positions?: number;
  armedBots?: number;
  mode?: MuseUiMode;
  via?: 'muse' | 'local';
  lastTune?: MuseLastTune | null;
}): MuseWatchLamp {
  const mode = input.mode || 'observe';
  const via = input.via || (input.configured ? 'muse' : 'local');
  const observeOnly = mode === 'observe';
  const localImprove = mode === 'improve';

  if (!input.configured && !localImprove) {
    return {
      available: false,
      observeOnly: true,
      mode,
      via: 'local',
      running: false,
      lastCycle: input.lastCycle,
      lastError: input.lastError || 'Muse not configured',
      ok: false,
      note: UNKNOWN_NOTE,
      positions: input.positions,
      armedBots: input.armedBots,
      lastTune: input.lastTune ?? null,
    };
  }
  if (input.lastError) {
    return {
      available: true,
      observeOnly,
      mode,
      via,
      running: input.running,
      lastCycle: input.lastCycle,
      lastError: input.lastError,
      ok: false,
      note: localImprove
        ? 'Muse improve error — treat as amber, not green.'
        : 'Muse watcher error — treat watch as unknown, not green.',
      positions: input.positions,
      armedBots: input.armedBots,
      lastTune: input.lastTune ?? null,
    };
  }
  const ok = !!(input.running || input.lastCycle);
  const tuneText = formatMuseTune(input.lastTune);
  const tune = tuneText || null;
  return {
    available: true,
    observeOnly,
    mode,
    via,
    running: input.running,
    lastCycle: input.lastCycle,
    lastError: null,
    ok,
    note: !ok
      ? (localImprove ? 'Muse improve — waiting for first cycle.' : 'Muse configured — waiting for first cycle (unknown, not green).')
      : localImprove
        ? `Muse improve (${via}). Never places orders.${tune ? ` ${tune}` : ''}`
        : 'Muse observe-only watcher. Never places orders.',
    positions: input.positions,
    armedBots: input.armedBots,
    lastTune: input.lastTune ?? null,
  };
}

export function museWatchStatus(opts?: { apiKey?: string | null }): MuseWatchLamp {
  const configured = museConfigured(opts);
  const mode = cachedMuseMode();
  return museWatchLamp({
    configured,
    running,
    lastCycle: lastCycle?.at ?? null,
    lastError,
    positions: lastCycle?.positions,
    armedBots: lastCycle?.armedBots,
    mode,
    via: configured ? 'muse' : 'local',
    lastTune: museLastTune(),
  });
}

function parseJsonish(v: any): any {
  if (v == null) return {};
  if (typeof v === 'object') return v;
  try { return JSON.parse(String(v)); } catch { return {}; }
}

/** One pass. Injectable readers for tests. Improve applies local edits on paper. */
export async function runMuseWatchCycle(deps: {
  env?: string;
  loadPositions?: (env: string) => Promise<{ symbol: string }[]>;
  loadBots?: (env: string) => Promise<any[]>;
  now?: () => string;
  improve?: boolean;
} = {}): Promise<MuseWatchCycle> {
  if (running) {
    return lastCycle || { at: new Date().toISOString(), env: 'unknown', positions: 0, armedBots: 0, symbols: [], error: 'already running' };
  }
  running = true;
  const at = deps.now ? deps.now() : new Date().toISOString();
  let env = deps.env || 'alpaca_paper';
  try {
    await loadMuseSettings().catch(() => {});
    const mode = cachedMuseMode();
    const doImprove = deps.improve != null ? deps.improve : mode === 'improve';
    env = deps.env || await getTradingEnv();
    const positions = deps.loadPositions
      ? await deps.loadPositions(env)
      : await q<{ symbol: string }>(
        'SELECT symbol FROM positions WHERE env=:env AND ABS(qty) > 0 ORDER BY updated_at DESC LIMIT 80',
        { env },
      );
    const bots = deps.loadBots
      ? await deps.loadBots(env)
      : await q<any>('SELECT id, name, enabled, mode, action, rules, risk, last_result FROM bots WHERE env=:env AND enabled=1', { env });
    const armed = (bots || []).filter((b) => {
      if (isObserveOnlyBot(b)) return false;
      const m = String(b.mode || parseJsonish(b.action)?.mode || '');
      return m === 'auto' || m === 'full_auto' || m === 'cautious';
    });
    const symbols = [...new Set([
      ...positions.map((p) => String(p.symbol || '').toUpperCase()).filter(Boolean),
      ...armed.map((b) => String(b.name || '').slice(0, 40)),
    ])].slice(0, 40);
    let improved = 0;
    if (doImprove && env === 'alpaca_paper') {
      const res = await applyMuseImprove(armed, { env, now: () => at, limit: 8 });
      improved = res.applied.length;
    }
    lastError = null;
    lastCycle = {
      at,
      env,
      positions: positions.length,
      armedBots: armed.length,
      symbols,
      error: null,
      improved,
    };
    await audit('muse.watch', `positions=${positions.length} armed=${armed.length} improved=${improved} mode=${mode}`, {
      env, positions: positions.length, armed: armed.length, improved, mode, observe_only: mode === 'observe',
    }).catch(() => {});
    return lastCycle;
  } catch (e: any) {
    const msg = String(e?.message || e).slice(0, 240);
    lastError = msg;
    lastCycle = { at, env, positions: 0, armedBots: 0, symbols: [], error: msg };
    await audit('muse.watch.error', msg, { observe_only: cachedMuseMode() === 'observe' }).catch(() => {});
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
