/**
 * Durable Muse mode. Default `improve` on paper — local heuristic still runs
 * when META_MUSE_API_KEY is unset. Muse never places orders.
 */

import { getSetting, setSetting } from '../db.js';

export type MuseUiMode = 'observe' | 'improve';

export type MuseSettings = {
  mode: MuseUiMode;
};

let cached: MuseSettings | null = null;

export function parseMuseMode(raw: unknown): MuseUiMode {
  const s = String(raw ?? '').trim().toLowerCase();
  return s === 'observe' ? 'observe' : 'improve';
}

export function cachedMuseMode(): MuseUiMode {
  return cached?.mode ?? 'improve';
}

export async function loadMuseSettings(io?: {
  get?: () => Promise<any>;
  set?: (s: MuseSettings) => Promise<void>;
}): Promise<MuseSettings> {
  if (cached && !io) return cached;
  try {
    const raw = io?.get ? await io.get() : await getSetting<any>('muse', null);
    if (raw && typeof raw === 'object') {
      cached = { mode: parseMuseMode(raw.mode) };
      return cached;
    }
    if (typeof raw === 'string') {
      cached = { mode: parseMuseMode(raw) };
      return cached;
    }
  } catch { /* default improve */ }
  cached = { mode: 'improve' };
  return cached;
}

export async function saveMuseSettings(
  patch: { mode?: string },
  io?: { set?: (s: MuseSettings) => Promise<void> },
): Promise<MuseSettings> {
  const next: MuseSettings = { mode: parseMuseMode(patch.mode ?? cachedMuseMode()) };
  cached = next;
  try {
    if (io?.set) await io.set(next);
    else await setSetting('muse', next);
  } catch { /* cache still updated */ }
  return next;
}

export function resetMuseSettingsForTests(): void {
  cached = null;
}
