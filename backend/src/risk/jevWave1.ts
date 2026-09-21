/**
 * Jev exit wave-1. Candidates may be armed later. Default stays off.
 * Deferred books cannot turn exit on. Alpaca paper only.
 * Actions sell or tighten. They never add, never widen the hard stop,
 * and never clear the gain-lock.
 */

export const JEV_EXIT_WAVE1_CANDIDATES = [89, 12, 86, 25, 21, 39, 91, 92] as const;
export const JEV_EXIT_WAVE1_DEFER_IDS = [84, 38] as const;

/** RTH exit cadence. Entry cadence is unchanged. */
export const JEV_EXIT_CADENCE_EXPIRY_MS = 2 * 60 * 1000;
export const JEV_EXIT_CADENCE_SHORT_MS = 3 * 60 * 1000;
export const JEV_EXIT_CADENCE_MEDIUM_MS = 12 * 60 * 1000;
/** About two checks in a regular session, and never faster than hourly. */
export const JEV_EXIT_CADENCE_LEAPS_MS = 3 * 60 * 60 * 1000;
export const JEV_EXIT_LEAPS_DTE = 90;
export const JEV_EXIT_EXPIRY_HOT_MIN = 90;

export const JEV_EXIT_CADENCE_BANDS = [
  { band: 'expiry', dte: '0 DTE, last 90 min', every: '2 min', ms: JEV_EXIT_CADENCE_EXPIRY_MS },
  { band: 'short', dte: '0 to 3', every: '3 min', ms: JEV_EXIT_CADENCE_SHORT_MS },
  { band: 'medium', dte: '4 to 14', every: '12 min', ms: JEV_EXIT_CADENCE_MEDIUM_MS },
  { band: 'between', dte: '15 to 89', every: '60 min', ms: 60 * 60 * 1000 },
  { band: 'leaps', dte: '90 and out', every: '3 hr', ms: JEV_EXIT_CADENCE_LEAPS_MS },
] as const;

export type JevExitDeskAction = 'CLOSE' | 'PARTIAL' | 'HOLD' | 'TIGHTEN_TRAIL';

export type JevWave1 = {
  candidate: boolean;
  deferred: boolean;
  /** Eligible to turn exit on. The stored flag still defaults off. */
  mayArm: boolean;
  exitDefault: false;
  why: string;
};

function asObj(v: unknown): Record<string, any> {
  if (typeof v === 'string') {
    try {
      const p = JSON.parse(v);
      return p && typeof p === 'object' ? p : {};
    } catch { return {}; }
  }
  return v && typeof v === 'object' ? v as Record<string, any> : {};
}

function botId(raw: unknown): number | null {
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

export function jevExitCadenceWindowMs(opts: {
  dte?: number | null;
  leaps?: boolean;
  minutesToClose?: number | null;
}): number {
  const dte = opts.dte == null || !Number.isFinite(Number(opts.dte)) ? null : Number(opts.dte);
  const leaps = opts.leaps === true || (dte != null && dte >= JEV_EXIT_LEAPS_DTE);
  if (leaps) return JEV_EXIT_CADENCE_LEAPS_MS;
  const hot = dte != null && dte <= 0
    && opts.minutesToClose != null
    && opts.minutesToClose >= 0
    && opts.minutesToClose <= JEV_EXIT_EXPIRY_HOT_MIN;
  if (hot) return JEV_EXIT_CADENCE_EXPIRY_MS;
  if (dte != null && dte <= 3) return JEV_EXIT_CADENCE_SHORT_MS;
  if (dte != null && dte <= 14) return JEV_EXIT_CADENCE_MEDIUM_MS;
  return 60 * 60 * 1000;
}

/** Wave-1 class. `exitDefault` is always false. Arming is a later explicit write. */
export function classifyJevExitWave1(bot: {
  id?: unknown;
  name?: unknown;
  action?: unknown;
  dte?: number | null;
} | null | undefined): JevWave1 {
  const id = botId(bot?.id);
  const action = asObj(bot?.action);
  const name = `${bot?.name || ''} ${action.name || ''} ${action._strategy || ''}`;
  const dte = bot?.dte == null ? null : Number(bot.dte);
  const zeroDte = dte === 0
    || action.dte === 0
    || String(action.expiration || '').toLowerCase() === '0dte'
    || /0\s*-?\s*dte/i.test(name);
  const mag7 = (id != null && (JEV_EXIT_WAVE1_DEFER_IDS as readonly number[]).includes(id) && id === 38)
    || /mag[\s-]*7/i.test(name);
  const covered = action.covered === true
    || /covered/.test(name.toLowerCase())
    || (String(action.side || '').toLowerCase() === 'sell' && /call/i.test(`${action.option_type || ''} ${name}`));
  const observe = action._observe_only === true || action.observe_only === true || /observe/.test(String(action.mode || ''));
  const coveredObserve = covered && (observe || /observe|watch/i.test(name) || action._observe_only === true);
  const leaps = (dte != null && dte >= 180)
    || String(action.expiration || '').toLowerCase() === 'leaps'
    || /\bleaps?\b/i.test(name);
  const pinnedDefer = id != null && (JEV_EXIT_WAVE1_DEFER_IDS as readonly number[]).includes(id);

  let why = 'not in exit wave-1';
  let deferred = false;
  if (id === 84 || zeroDte) {
    deferred = true;
    why = '0-DTE is deferred';
  } else if (id === 38 || mag7) {
    deferred = true;
    why = 'Mag-7 fleet is deferred';
  } else if (coveredObserve || (covered && (observe || String(action.side || '').toLowerCase() === 'sell'))) {
    deferred = true;
    why = 'covered-call observe is deferred';
  } else if (leaps) {
    deferred = true;
    why = 'speculative LEAPS are deferred';
  } else if (pinnedDefer) {
    deferred = true;
    why = 'this bot is deferred from exit wave-1';
  }

  const candidate = id != null && (JEV_EXIT_WAVE1_CANDIDATES as readonly number[]).includes(id) && !deferred;
  if (candidate) why = 'wave-1 candidate. Exit stays off until you turn it on.';
  return { candidate, deferred, mayArm: candidate, exitDefault: false, why };
}

/** True only when this book may store exit on. The flag itself stays off until an explicit write. */
export function jevExitFlagForWave(exit: boolean, bot: Parameters<typeof classifyJevExitWave1>[0]): boolean {
  if (!exit) return false;
  return classifyJevExitWave1(bot).mayArm;
}

/** Refuse arming exit. exit false is always allowed and does not call this. */
export function jevExitArmError(env: string, bot: Parameters<typeof classifyJevExitWave1>[0]): string | null {
  if (env !== 'alpaca_paper') return 'Jev exit stays on Alpaca paper.';
  const wave = classifyJevExitWave1(bot);
  if (!wave.mayArm) return wave.why;
  return null;
}

/** After a PARTIAL fill, keep the remainder open. A full fill closes. A zero fill does not. */
export function jevPartialRemain(heldQty: number, soldQty: number): { remain: number; closeAll: boolean; applied: boolean } {
  const held = Math.floor(Number(heldQty));
  const sold = Math.floor(Number(soldQty));
  if (!(held >= 1) || !(sold >= 1)) return { remain: Math.max(0, held), closeAll: false, applied: false };
  const remain = held - sold;
  if (remain >= 1) return { remain, closeAll: false, applied: true };
  return { remain: 0, closeAll: true, applied: true };
}

/** Sell size for a Jev exit. Never a buy, never more than held, partial keeps a remainder. */
export function jevExitOrder(pick: 'hold' | 'exit' | 'tighten' | 'partial', heldQty: number): { side: 'sell'; qty: number } | null {
  const held = Math.floor(Number(heldQty));
  if (!(held >= 1)) return null;
  if (pick === 'exit') return { side: 'sell', qty: held };
  if (pick === 'partial') {
    if (held < 2) return null;
    const qty = Math.min(held - 1, Math.max(1, Math.floor(held / 2)));
    if (!(qty >= 1) || qty >= held) return null;
    return { side: 'sell', qty };
  }
  return null;
}
