/**
 * Durable Jev UI settings. Env `JEV_ENTRY_MODE` is the seed only.
 * `off` never calls TypeSafe and fail-opens paper entries.
 */

import { getSetting, setSetting } from '../db.js';
import { config } from '../config.js';

export type JevUiMode = 'off' | 'shadow' | 'active';

export type JevSettings = {
  enabled: boolean;
  mode: JevUiMode;
};

export type JevSettingsIo = {
  get?: () => Promise<Partial<JevSettings> | null>;
  set?: (s: JevSettings) => Promise<void>;
};

let cached: JevSettings | null = null;

export function parseJevUiMode(raw: unknown): JevUiMode {
  const s = String(raw ?? '').trim().toLowerCase();
  if (s === 'off' || s === 'disabled' || s === 'false') return 'off';
  if (s === 'active') return 'active';
  return 'shadow';
}

export function seedJevSettings(): JevSettings {
  const seeded = parseJevUiMode(config.typesafe.entryMode);
  return { enabled: seeded !== 'off', mode: seeded };
}

export function effectiveJevMode(s: JevSettings): JevUiMode {
  if (!s.enabled || s.mode === 'off') return 'off';
  return s.mode;
}

export function cachedJevEffective(): JevUiMode {
  return cached ? effectiveJevMode(cached) : parseJevUiMode(config.typesafe.entryMode);
}

export async function loadJevSettings(io?: JevSettingsIo): Promise<JevSettings> {
  if (cached && !io) return cached;
  const seed = seedJevSettings();
  try {
    const raw = io?.get ? await io.get() : await getSetting<any>('jev', null);
    if (raw && typeof raw === 'object') {
      const mode = parseJevUiMode(raw.mode ?? seed.mode);
      const enabled = raw.enabled === false || raw.enabled === 0 || raw.enabled === 'false'
        ? false
        : raw.enabled === true || raw.enabled === 1 || mode !== 'off';
      cached = { enabled: mode === 'off' ? false : enabled, mode };
      return cached;
    }
  } catch { /* env seed */ }
  cached = seed;
  return cached;
}

export async function saveJevSettings(
  patch: { enabled?: boolean; mode?: string },
  io?: JevSettingsIo,
): Promise<JevSettings> {
  const cur = await loadJevSettings(io);
  let mode = patch.mode != null ? parseJevUiMode(patch.mode) : cur.mode;
  let enabled = cur.enabled;
  if (patch.enabled === false) enabled = false;
  if (patch.enabled === true) {
    enabled = true;
    if (mode === 'off') mode = 'shadow';
  }
  if (patch.mode != null && mode === 'off') enabled = false;
  if (patch.mode != null && mode !== 'off' && patch.enabled == null) enabled = true;
  const next: JevSettings = { enabled, mode };
  cached = next;
  try {
    if (io?.set) await io.set(next);
    else await setSetting('jev', next);
  } catch { /* still return process cache */ }
  return next;
}

export function resetJevSettingsForTests(): void {
  cached = null;
}
