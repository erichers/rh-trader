/**
 * Per-bot Jev scope and the exit/rail merge.
 *
 * Bot risk JSON stores `jev: { entry, exit }`. Missing flags are off.
 * A decision is acted on only when global mode is active, the bot allows
 * that kind, and the account is Alpaca paper. Otherwise we log and stand down.
 * Hard-stop / gain-lock / trail reasons are never cleared here.
 */

import { exitReason } from './exitpolicy.js';

export type JevBotFlags = { entry: boolean; exit: boolean };
export type JevActKind = 'entry' | 'exit';

export type JevEffective = {
  /** Global active and the bot allows this kind, on Alpaca paper. */
  apply: boolean;
  /** Spend a TypeSafe call. Cadence and the $5 budget still apply. */
  call: boolean;
  mode: 'shadow' | 'active';
  reason: 'global_off' | 'per_bot_off' | 'global_shadow' | 'active' | 'paper_only';
};

export const JEV_CADENCE_SHORT_MS = 5 * 60 * 1000;
export const JEV_CADENCE_MEDIUM_MS = 20 * 60 * 1000;
export const JEV_CADENCE_OTHER_MS = 60 * 60 * 1000;
export const JEV_CADENCE_LEAPS_MS = 4 * 60 * 60 * 1000;

/** Desk copy for these bands lives in the UI. Numbers are the one source of truth. */
export const JEV_CADENCE_BANDS = [
  { band: 'short', dte: '0 to 3', every: '5 min', ms: JEV_CADENCE_SHORT_MS },
  { band: 'medium', dte: '4 to 14', every: '20 min', ms: JEV_CADENCE_MEDIUM_MS },
  { band: 'between', dte: '15 to 179', every: '60 min', ms: JEV_CADENCE_OTHER_MS },
  { band: 'leaps', dte: '180 and out', every: '4 hr', ms: JEV_CADENCE_LEAPS_MS },
] as const;

const stamps = new Map<string, { at: number; replay: unknown }>();

export function resetJevCadenceForTests(): void {
  stamps.clear();
}

function flagOn(v: unknown): boolean {
  return v === true || v === 1 || v === '1' || v === 'true';
}

/** Default off. Only an explicit true on `risk.jev.entry` / `risk.jev.exit` enables a scope. */
export function parseJevBotFlags(risk: unknown): JevBotFlags {
  let r: any = risk;
  if (typeof r === 'string') {
    const s = r.trim();
    if (!s) return { entry: false, exit: false };
    try { r = JSON.parse(s); } catch { return { entry: false, exit: false }; }
  }
  if (!r || typeof r !== 'object') return { entry: false, exit: false };
  const j = (r as any).jev;
  if (j && typeof j === 'object') return { entry: flagOn(j.entry), exit: flagOn(j.exit) };
  if (('entry' in r || 'exit' in r) && !('stop_loss_pct' in r) && !('take_profit_pct' in r) && !('symbols' in r)) {
    return { entry: flagOn((r as any).entry), exit: flagOn((r as any).exit) };
  }
  return { entry: false, exit: false };
}

export function jevEffective(opts: {
  global: 'off' | 'shadow' | 'active';
  flags: JevBotFlags;
  kind: JevActKind;
  /** Unit tests and AI drafts with no bot row keep the pre-scope call behavior. */
  legacyOpen?: boolean;
  /** `false` means not Alpaca paper. Undefined does not force the paper gate (tests). */
  paper?: boolean;
}): JevEffective {
  if (opts.global === 'off') return { apply: false, call: false, mode: 'shadow', reason: 'global_off' };
  if (opts.paper === false) return { apply: false, call: false, mode: 'shadow', reason: 'paper_only' };
  const on = opts.legacyOpen ? true : (opts.kind === 'entry' ? opts.flags.entry : opts.flags.exit);
  if (!on) return { apply: false, call: false, mode: 'shadow', reason: 'per_bot_off' };
  if (opts.global === 'shadow') return { apply: false, call: true, mode: 'shadow', reason: 'global_shadow' };
  return { apply: true, call: true, mode: 'active', reason: 'active' };
}

export function parseJevDte(raw: unknown): number | null {
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
  if (raw == null || raw === '') return null;
  const m = String(raw).match(/-?\d+(\.\d+)?/);
  if (!m) return null;
  const n = Number(m[0]);
  return Number.isFinite(n) ? n : null;
}

export function jevCadenceWindowMs(dte: number | null | undefined, leaps = false): number {
  if (leaps || (dte != null && dte >= 180)) return JEV_CADENCE_LEAPS_MS;
  if (dte != null && dte <= 3) return JEV_CADENCE_SHORT_MS;
  if (dte != null && dte <= 14) return JEV_CADENCE_MEDIUM_MS;
  return JEV_CADENCE_OTHER_MS;
}

/** Entry cadence keys require a bot id so legacy single-shot tests do not share a window. */
export function jevCadenceKey(
  kind: JevActKind,
  parts: { botId?: unknown; symbol?: unknown; occ?: unknown; monitorId?: unknown },
): string | null {
  if (kind === 'entry') {
    if (parts.botId == null || parts.botId === '') return null;
    const sym = String(parts.symbol || '').trim().toUpperCase();
    if (!sym) return null;
    return `entry:${parts.botId}:${sym}`;
  }
  const id = parts.monitorId ?? parts.occ ?? parts.symbol;
  if (id == null || id === '') return null;
  return `exit:${parts.botId ?? 'na'}:${id}`;
}

export function takeFreshCadence<T>(key: string | null, now: number, windowMs: number): T | null {
  if (!key) return null;
  const s = stamps.get(key);
  if (!s) return null;
  if (now - s.at >= windowMs) return null;
  return s.replay as T;
}

export function rememberCadence(key: string | null, now: number, replay: unknown): void {
  if (!key) return;
  stamps.set(key, { at: now, replay });
}

/** Narrow the trail. Never invent one, never loosen, never touch the hard stop. */
export function tightenTrail(trailPct: number): number {
  const t = Number(trailPct);
  if (!Number.isFinite(t) || t <= 0) return 0;
  const next = Math.max(4, Math.round(t * 0.7 * 10) / 10);
  return Math.min(t, next);
}

export type JevExitAction = 'hold' | 'exit' | 'tighten';

/**
 * Merge a Jev exit opinion onto a rail reason.
 * A non-null rail (stop-loss, gain-lock, trail, flatten, soft TP) is kept as-is.
 * Jev hold never clears it. Trail may only shrink, and only when there is no rail yet.
 */
export function mergeJevExit(opts: {
  railReason: string | null;
  pick: JevExitAction;
  applied: boolean;
  trailPct: number;
  slPct: number;
}): { reason: string | null; trailPct: number; slPct: number } {
  const slPct = opts.slPct;
  if (opts.railReason) {
    return { reason: opts.railReason, trailPct: opts.trailPct, slPct };
  }
  if (!opts.applied || opts.pick === 'hold') {
    return { reason: null, trailPct: opts.trailPct, slPct };
  }
  if (opts.pick === 'exit') {
    return { reason: 'jev-exit', trailPct: opts.trailPct, slPct };
  }
  return { reason: null, trailPct: tightenTrail(opts.trailPct), slPct };
}

/**
 * Monitor exit resolver. Rails are computed first. Jev cannot delete them.
 * A tighten re-checks the trail; the hard stop still uses the original sl.
 */
export function resolveMonitorExit(opts: {
  railReason: string | null;
  jev: { pick: JevExitAction; applied: boolean } | null;
  trailPct: number;
  slPct: number;
  tpPct: number;
  fav: number;
  peak: number;
}): { reason: string | null; trailPct: number; slPct: number } {
  const slPct = opts.slPct;
  if (opts.railReason) {
    const locked = mergeJevExit({
      railReason: opts.railReason,
      pick: 'hold',
      applied: false,
      trailPct: opts.trailPct,
      slPct,
    });
    return locked;
  }
  const merged = mergeJevExit({
    railReason: null,
    pick: opts.jev?.pick ?? 'hold',
    applied: !!opts.jev?.applied,
    trailPct: opts.trailPct,
    slPct,
  });
  let reason = merged.reason;
  const trailPct = merged.trailPct;
  if (trailPct !== opts.trailPct) {
    const again = exitReason(opts.fav, opts.peak, { tp: opts.tpPct, sl: slPct, trail: trailPct });
    if (again) reason = again;
  }
  return { reason, trailPct, slPct };
}
