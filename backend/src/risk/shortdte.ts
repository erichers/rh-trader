/**
 * 0–1 DTE is blocked for the fleet. Only this explicit allowlist may take
 * same-day / next-day options, and only with the tight SL / TP / size rails
 * below. A flag on a random bot is not enough — the key (or name) must match.
 */

export const SHORT_DTE_ALLOWLIST = [
  {
    key: 'ai-catalyst-call',
    nameRe: /ai catalyst/i,
    why: 'Claude-gated (≥0.7 conviction) + EMA cross — highest-certainty option template in the strategy library',
  },
  {
    key: 'accel_dual_momentum_call',
    nameRe: /dual-horizon momentum/i,
    why: 'Stacked 5d+10d momentum above EMA50 — fewest, highest-conviction QuickBot continuation entries',
  },
] as const;

export type ShortDteAllowlistEntry = (typeof SHORT_DTE_ALLOWLIST)[number];

/** Hard rails for a privileged 0–1 DTE buy. Loose SL/TP cannot pass. */
export const SHORT_DTE_RAILS = {
  slMax: 5,
  tpMin: 6,
  tpMax: 12,
  trailMax: 6,
  maxPositionUsd: 400,
} as const;

export const SHORT_DTE_BAND = {
  tp: 10,
  sl: SHORT_DTE_RAILS.slMax,
  trail: 4,
  max_position_usd: SHORT_DTE_RAILS.maxPositionUsd,
  qty: 1,
} as const;

export type ShortDteIdentity = {
  key?: string | null;
  name?: string | null;
  /** Extra keys (strategy, play, tag) scanned against the allowlist. */
  keys?: Array<string | null | undefined>;
};

function normKey(s: string | null | undefined): string {
  return String(s || '').trim().toLowerCase();
}

export function shortDteAllowlistHit(id: ShortDteIdentity): ShortDteAllowlistEntry | null {
  const keys = new Set<string>();
  const add = (k?: string | null) => {
    const n = normKey(k);
    if (n) keys.add(n);
  };
  add(id.key);
  for (const k of id.keys || []) add(k);
  for (const row of SHORT_DTE_ALLOWLIST) {
    if (keys.has(row.key)) return row;
    if (id.name && row.nameRe.test(String(id.name))) return row;
  }
  return null;
}

/** True only when the bot/play is on the allowlist. A lone flag does not grant 0–1. */
export function isShortDtePrivileged(id: ShortDteIdentity): boolean {
  return shortDteAllowlistHit(id) != null;
}

export function shortDteRailsOk(opts: {
  sl?: number | null;
  tp?: number | null;
  trail?: number | null;
  maxPositionUsd?: number | null;
}): { ok: boolean; detail: string } {
  const sl = Number(opts.sl);
  const tp = Number(opts.tp);
  const trail = opts.trail == null ? 0 : Number(opts.trail);
  const usd = opts.maxPositionUsd == null ? null : Number(opts.maxPositionUsd);
  if (!Number.isFinite(sl) || !(sl > 0) || sl > SHORT_DTE_RAILS.slMax) {
    return { ok: false, detail: `0–1 DTE stop must be 0 < sl ≤ ${SHORT_DTE_RAILS.slMax}% (got ${opts.sl ?? 'missing'})` };
  }
  if (!Number.isFinite(tp) || tp < SHORT_DTE_RAILS.tpMin || tp > SHORT_DTE_RAILS.tpMax) {
    return {
      ok: false,
      detail: `0–1 DTE take-profit must be ${SHORT_DTE_RAILS.tpMin}–${SHORT_DTE_RAILS.tpMax}% (got ${opts.tp ?? 'missing'}; no “let it run”)`,
    };
  }
  if (Number.isFinite(trail) && trail > SHORT_DTE_RAILS.trailMax) {
    return { ok: false, detail: `0–1 DTE trail must be ≤ ${SHORT_DTE_RAILS.trailMax}% (got ${trail})` };
  }
  if (usd != null && Number.isFinite(usd) && usd > SHORT_DTE_RAILS.maxPositionUsd) {
    return { ok: false, detail: `0–1 DTE size must be ≤ $${SHORT_DTE_RAILS.maxPositionUsd} (got ${usd})` };
  }
  return { ok: true, detail: `tight 0–1 rails sl ${sl} / tp ${tp} / size ${usd ?? 'uncapped-then-clamped'}` };
}
