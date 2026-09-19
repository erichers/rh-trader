import { ENTRY_DTE_MAX, ENTRY_DTE_MIN } from './exitpolicy.js';
import { decideGo, gate, score, FAIL, PASS, UNKNOWN, type Decision } from './decide.js';
import {
  isShortDtePrivileged,
  shortDteAllowlistHit,
  shortDteRailsOk,
  type ShortDteIdentity,
} from './shortdte.js';

/** Calendar days from ET today to an ISO expiration (YYYY-MM-DD). 0 = 0DTE. */
export const LEAPS_DTE_MIN = 180;

export function calendarDte(expirationISO: string, now: Date = new Date()): number | null {
  const exp = String(expirationISO || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(exp)) return null;
  const etToday = now.toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  const ms = Date.parse(`${exp}T16:00:00-04:00`) - Date.parse(`${etToday}T16:00:00-04:00`);
  if (!Number.isFinite(ms)) return null;
  return Math.round(ms / 864e5);
}

/** ET calendar date `dte` days ahead (YYYY-MM-DD). Matches calendarDte, not UTC trading days. */
export function dteToExpiration(dte: number, now: Date = new Date()): string {
  const n = Math.round(Number(dte));
  const days = Number.isFinite(n) && n > 0 ? n : 0;
  const etToday = now.toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  const start = Date.parse(`${etToday}T16:00:00-04:00`);
  const target = new Date(start + days * 864e5);
  return target.toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
}

export function isLeapsLabel(name?: string | null, key?: string | null): boolean {
  return /\bleaps?\b/i.test(`${name || ''} ${key || ''}`);
}

export function isLeapsTrade(opts: {
  expiration?: string | null;
  dte?: number | null;
  name?: string | null;
  key?: string | null;
  now?: Date;
}): boolean {
  if (isLeapsLabel(opts.name, opts.key)) return true;
  const pref = String(opts.expiration || '').toLowerCase();
  if (pref === 'leaps') return true;
  if (typeof opts.dte === 'number' && Number.isFinite(opts.dte) && opts.dte >= LEAPS_DTE_MIN) return true;
  if (/^\d{4}-\d{2}-\d{2}$/.test(pref)) {
    const d = calendarDte(pref, opts.now);
    if (d != null && d >= LEAPS_DTE_MIN) return true;
  }
  return false;
}

export type DraftDteHint = {
  asset_class?: string;
  side?: string;
  expiration?: string;
  _play?: {
    dte?: number;
    tp?: number;
    sl?: number;
    trail?: number;
    maxPositionUsd?: number;
    name?: string;
    tag?: string;
    key?: string;
    allow_0_1_dte?: boolean;
  };
  _contract?: { expiration?: string };
  name?: string;
  key?: string;
  allow_0_1_dte?: boolean;
};

export type EntryDteVerdict = {
  ok: boolean;
  detail: string;
  dte: number | null;
  leaps: boolean;
  source: 'contract' | 'expiration' | 'none';
  privileged: boolean;
  decision: Decision;
};

export type PickExpirationOpts = {
  pref?: string;
  targetDte?: number | null;
  allowShortDte?: boolean;
  now?: Date;
  name?: string | null;
  key?: string | null;
};

/**
 * Pick a listed expiration using the SAME ET calendar DTE as the risk gate.
 * Normal fleet: 2–14 only (never 0–1). Privileged: 0–14. LEAPS: furthest ≥180.
 * Past / weekly ISO dates do not snap onto tomorrow's daily expiry.
 * Fail-closed: null when nothing in the allowed window.
 */
export function pickListedExpiration(exps: string[], opts: PickExpirationOpts = {}): string | null {
  if (!exps.length) return null;
  const now = opts.now ?? new Date();
  const prefRaw = String(opts.pref || '');
  const pref = prefRaw.toLowerCase();
  const scored = exps
    .map((e) => ({ e, dte: calendarDte(e, now) }))
    .filter((x): x is { e: string; dte: number } => x.dte != null && Number.isFinite(x.dte));
  if (!scored.length) return null;

  const leapsPref = isLeapsTrade({
    expiration: prefRaw, dte: opts.targetDte, name: opts.name, key: opts.key, now,
  });
  if (leapsPref) {
    if (/^\d{4}-\d{2}-\d{2}$/.test(prefRaw) && exps.includes(prefRaw)) {
      const d = calendarDte(prefRaw, now);
      if (d != null && d >= LEAPS_DTE_MIN) return prefRaw;
      if (d != null && d < ENTRY_DTE_MIN) return null;
    }
    const leaps = scored.filter((x) => x.dte >= LEAPS_DTE_MIN);
    if (leaps.length) return leaps.reduce((b, x) => (x.dte > b.dte ? x : b)).e;
    return null;
  }

  const min = opts.allowShortDte ? 0 : ENTRY_DTE_MIN;
  const window = scored.filter((x) => x.dte >= min && x.dte <= ENTRY_DTE_MAX);
  if (!window.length) return null;

  let target: number | null = opts.targetDte != null && Number.isFinite(Number(opts.targetDte))
    ? Number(opts.targetDte)
    : null;
  if (target == null && /^\d{4}-\d{2}-\d{2}$/.test(prefRaw)) {
    target = calendarDte(prefRaw, now);
  } else if (target == null && pref === 'monthly') {
    target = ENTRY_DTE_MAX;
  } else if (target == null) {
    target = 7;
  }
  if (target == null || !Number.isFinite(target)) target = 7;
  if (!opts.allowShortDte && target < ENTRY_DTE_MIN) target = ENTRY_DTE_MIN;
  if (target > ENTRY_DTE_MAX && target < LEAPS_DTE_MIN) target = ENTRY_DTE_MAX;

  return window.reduce((best, x) => {
    const db = Math.abs(best.dte - target!);
    const dx = Math.abs(x.dte - target!);
    if (dx < db) return x;
    if (dx === db && x.dte > best.dte) return x; // tie: further from 0–1
    return best;
  }).e;
}

/** After a concrete contract is chosen, play.dte becomes that contract's calendar DTE. */
export function syncPlayDteToContract<T extends DraftDteHint>(draft: T, now: Date = new Date()): T {
  const exp = draft._contract?.expiration;
  if (!exp || !/^\d{4}-\d{2}-\d{2}$/.test(exp)) return draft;
  const dte = calendarDte(exp, now);
  if (dte == null) return draft;
  draft._play = { ...(draft._play || {}), dte };
  if (/^\d{4}-\d{2}-\d{2}$/.test(String(draft.expiration || '')) || !draft.expiration) {
    draft.expiration = exp;
  }
  return draft;
}

export function draftShortDteIdentity(draft: DraftDteHint): ShortDteIdentity {
  return {
    key: draft.key || draft._play?.key,
    name: draft.name || draft._play?.name,
    keys: [draft.key, draft._play?.key, draft._play?.tag],
  };
}

function resolvedExpiration(draft: DraftDteHint): { exp: string; source: 'contract' | 'expiration' } | null {
  const c = String(draft._contract?.expiration || '');
  if (/^\d{4}-\d{2}-\d{2}$/.test(c)) return { exp: c, source: 'contract' };
  const raw = String(draft.expiration || '');
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return { exp: raw, source: 'expiration' };
  return null;
}

export function entryDteAllowed(dte: number | null, leaps: boolean, privileged = false): { ok: boolean; detail: string } {
  if (leaps) {
    if (dte != null && dte < ENTRY_DTE_MIN) {
      return { ok: false, detail: `${dte}DTE blocked — never 0DTE/1DTE (even LEAPS)` };
    }
    return { ok: true, detail: dte != null ? `LEAPS ${dte}DTE` : 'LEAPS' };
  }
  if (dte == null || !Number.isFinite(dte)) {
    return { ok: false, detail: 'option DTE unknown — fail-closed (0DTE/1DTE blocked)' };
  }
  if (dte < ENTRY_DTE_MIN) {
    if (privileged && dte >= 0) {
      return { ok: true, detail: `${dte}DTE privileged 0–1 (allowlist)` };
    }
    return { ok: false, detail: `${dte}DTE blocked — never 0DTE/1DTE; entry window ${ENTRY_DTE_MIN}–${ENTRY_DTE_MAX} DTE` };
  }
  if (dte > ENTRY_DTE_MAX) {
    return { ok: false, detail: `${dte}DTE blocked — entry window ${ENTRY_DTE_MIN}–${ENTRY_DTE_MAX} DTE (LEAPS excepted)` };
  }
  return { ok: true, detail: `${dte}DTE inside ${ENTRY_DTE_MIN}–${ENTRY_DTE_MAX}` };
}

function emptyDecision(because: string, go: boolean): Decision {
  return { go, confidence: go ? 1 : 0, because, answers: [] };
}

/** Resolve the DTE we would actually buy. Play.dte alone cannot pass (fail-closed). */
export function resolveEntryDte(draft: DraftDteHint, now: Date = new Date()): EntryDteVerdict {
  const identity = draftShortDteIdentity(draft);
  const privileged = isShortDtePrivileged(identity);
  const hit = shortDteAllowlistHit(identity);
  const leaps = isLeapsTrade({
    expiration: draft._contract?.expiration || draft.expiration,
    dte: draft._play?.dte,
    name: identity.name,
    key: identity.key,
    now,
  });

  const resolved = resolvedExpiration(draft);
  const dte = resolved ? calendarDte(resolved.exp, now) : null;
  const source = resolved?.source ?? 'none';

  const resolvedGate = gate({
    id: 'contract_resolved',
    pick: resolved || leaps ? PASS : UNKNOWN,
    because: resolved
      ? `${source} expiration ${resolved.exp} → ${dte}DTE`
      : leaps
        ? 'LEAPS label — DTE window waived'
        : 'option expiration unresolved — cannot prove 2–14 DTE (0DTE/1DTE blocked)',
    evidence: { source, expiration: resolved?.exp ?? null, dte, play_dte: draft._play?.dte ?? null },
  });

  let windowPick: typeof PASS | typeof FAIL | typeof UNKNOWN = UNKNOWN;
  let windowBecause = 'option DTE unknown — fail-closed (0DTE/1DTE blocked)';
  if (leaps && (dte == null || dte >= ENTRY_DTE_MIN)) {
    windowPick = PASS;
    windowBecause = dte != null ? `LEAPS ${dte}DTE` : 'LEAPS — DTE window waived';
  } else if (dte == null) {
    windowPick = UNKNOWN;
  } else if (dte < 0) {
    windowPick = FAIL;
    windowBecause = `${dte}DTE blocked — expiration already passed`;
  } else if (dte < ENTRY_DTE_MIN) {
    if (privileged) {
      windowPick = PASS;
      windowBecause = `${dte}DTE privileged 0–1 (${hit?.key || 'allowlist'})`;
    } else {
      windowPick = FAIL;
      windowBecause = `${dte}DTE blocked — never 0DTE/1DTE; entry window ${ENTRY_DTE_MIN}–${ENTRY_DTE_MAX} DTE`;
    }
  } else if (dte > ENTRY_DTE_MAX) {
    windowPick = FAIL;
    windowBecause = `${dte}DTE blocked — entry window ${ENTRY_DTE_MIN}–${ENTRY_DTE_MAX} DTE (LEAPS excepted)`;
  } else {
    windowPick = PASS;
    windowBecause = `${dte}DTE inside ${ENTRY_DTE_MIN}–${ENTRY_DTE_MAX}`;
  }

  const windowGate = gate({
    id: 'dte_window',
    pick: windowPick,
    because: windowBecause,
    evidence: { dte, privileged, allowlist: hit?.key ?? null, leaps },
  });

  const short = dte != null && dte <= 1 && !leaps;
  let railsPick: typeof PASS | typeof FAIL | typeof UNKNOWN = PASS;
  let railsBecause = short ? '0–1 DTE rails not evaluated' : '0–1 rails n/a';
  if (short && privileged) {
    const rails = shortDteRailsOk({
      sl: draft._play?.sl,
      tp: draft._play?.tp,
      trail: draft._play?.trail,
      maxPositionUsd: draft._play?.maxPositionUsd,
    });
    railsPick = rails.ok ? PASS : FAIL;
    railsBecause = rails.detail;
  } else if (short && !privileged) {
    railsPick = FAIL;
    railsBecause = `${dte}DTE blocked — bot is not on the 0–1 allowlist`;
  }

  const railsGate = gate({
    id: 'short_dte_rails',
    pick: railsPick,
    because: railsBecause,
    evidence: {
      sl: draft._play?.sl ?? null,
      tp: draft._play?.tp ?? null,
      trail: draft._play?.trail ?? null,
      maxPositionUsd: draft._play?.maxPositionUsd ?? null,
      privileged,
    },
  });

  // Tightness rubric: 0 missing, 1 loose, 2 acceptable, 3 tight. Floor 2 when 0–1 privileged.
  let tightness = 3;
  if (short && privileged) {
    const sl = Number(draft._play?.sl);
    const tp = Number(draft._play?.tp);
    if (!Number.isFinite(sl) || !Number.isFinite(tp)) tightness = 0;
    else if (sl > 5 || tp > 12 || tp < 6) tightness = 1;
    else if (sl <= 3 && tp <= 10) tightness = 3;
    else tightness = 2;
  }
  const tightnessScore = score({
    id: 'exit_tightness',
    levels: ['missing', 'loose', 'acceptable', 'tight'],
    value: tightness,
    because: short && privileged ? `exit tightness ${tightness}` : 'exit tightness n/a',
    evidence: { tightness, short, privileged },
  });

  const decision = decideGo({
    answers: [resolvedGate, windowGate, railsGate, tightnessScore],
    scoreFloors: short && privileged ? { exit_tightness: 2 } : {},
  });

  return {
    ok: decision.go,
    detail: decision.go ? windowBecause : decision.because,
    dte,
    leaps,
    source,
    privileged,
    decision,
  };
}

/** Risk-engine wrapper: option buys only. Sells and shares pass. */
export function optionEntryDteCheck(draft: DraftDteHint, now?: Date): EntryDteVerdict {
  const ac = (draft.asset_class || 'equity').toLowerCase();
  if (ac !== 'option' || draft.side === 'sell') {
    return {
      ok: true,
      detail: 'not an option buy',
      dte: null,
      leaps: false,
      source: 'none',
      privileged: false,
      decision: emptyDecision('not an option buy', true),
    };
  }
  return resolveEntryDte(draft, now);
}

export { isShortDtePrivileged, shortDteAllowlistHit, SHORT_DTE_ALLOWLIST, SHORT_DTE_RAILS, SHORT_DTE_BAND } from './shortdte.js';
