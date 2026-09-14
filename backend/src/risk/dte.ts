import { ENTRY_DTE_MAX, ENTRY_DTE_MIN } from './exitpolicy.js';

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
  _play?: { dte?: number };
  _contract?: { expiration?: string };
  name?: string;
  key?: string;
};

export type EntryDteVerdict = {
  ok: boolean;
  detail: string;
  dte: number | null;
  leaps: boolean;
  source: 'contract' | 'play' | 'expiration' | 'none';
};

/** Resolve the DTE we would actually buy, preferring the concrete contract. */
export function resolveEntryDte(draft: DraftDteHint, now: Date = new Date()): EntryDteVerdict {
  const exp = draft._contract?.expiration;
  if (exp && /^\d{4}-\d{2}-\d{2}$/.test(exp)) {
    const dte = calendarDte(exp, now);
    const leaps = isLeapsTrade({ expiration: exp, dte, name: draft.name, key: draft.key, now });
    return { ...entryDteAllowed(dte, leaps), dte, leaps, source: 'contract' };
  }
  const playDte = Number(draft._play?.dte);
  if (Number.isFinite(playDte) && playDte >= 0) {
    const leaps = isLeapsTrade({ dte: playDte, expiration: draft.expiration, name: draft.name, key: draft.key, now });
    return { ...entryDteAllowed(playDte, leaps), dte: playDte, leaps, source: 'play' };
  }
  const raw = String(draft.expiration || '');
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    const dte = calendarDte(raw, now);
    const leaps = isLeapsTrade({ expiration: raw, dte, name: draft.name, key: draft.key, now });
    return { ...entryDteAllowed(dte, leaps), dte, leaps, source: 'expiration' };
  }
  const leaps = isLeapsTrade({ expiration: raw, name: draft.name, key: draft.key, now });
  if (leaps) return { ok: true, detail: 'LEAPS — DTE window waived', dte: null, leaps: true, source: 'none' };
  return {
    ok: false,
    detail: 'option expiration unresolved — cannot prove 2–14 DTE (0DTE/1DTE blocked)',
    dte: null,
    leaps: false,
    source: 'none',
  };
}

export function entryDteAllowed(dte: number | null, leaps: boolean): { ok: boolean; detail: string } {
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
    return { ok: false, detail: `${dte}DTE blocked — never 0DTE/1DTE; entry window ${ENTRY_DTE_MIN}–${ENTRY_DTE_MAX} DTE` };
  }
  if (dte > ENTRY_DTE_MAX) {
    return { ok: false, detail: `${dte}DTE blocked — entry window ${ENTRY_DTE_MIN}–${ENTRY_DTE_MAX} DTE (LEAPS excepted)` };
  }
  return { ok: true, detail: `${dte}DTE inside ${ENTRY_DTE_MIN}–${ENTRY_DTE_MAX}` };
}

/** Risk-engine wrapper: option buys only. Sells and shares pass. */
export function optionEntryDteCheck(draft: DraftDteHint, now?: Date): EntryDteVerdict {
  const ac = (draft.asset_class || 'equity').toLowerCase();
  if (ac !== 'option' || draft.side === 'sell') {
    return { ok: true, detail: 'not an option buy', dte: null, leaps: false, source: 'none' };
  }
  return resolveEntryDte(draft, now);
}
