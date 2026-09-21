// Shared exit policy — the ONE place that decides when a long position exits, used by BOTH
// the live monitor (risk/monitor.ts) and the backtest simulator (quickbot.ts). Keeping them
// identical is a hard rule: if backtest and live disagree, the backtest numbers are lies.
//
// Eric's locked SWING LAW (Monday paper / full_auto):
//   1. HARD STOP −10% from entry — cut losers fast. A wider bot sl cannot loosen this.
//   2. GAIN-LOCK arms at +10% with floor 0 (breakeven). A trade that was up ≥10%
//      may never close negative. The trailing stop also stays dormant until this peak.
//   3. Soft take-profit goal ~20%: close when hit IF there is no trail to ride;
//      otherwise the trail keeps riding winners past 20%.
//   4. Ratcheting trail — base width 10%, tighter as the win grows.

export type ExitBand = { tp: number; sl: number; trail: number };

export const HARD_STOP_PCT = 10;
export const GAIN_LOCK_ARM_PCT = 10;
export const GAIN_LOCK_FLOOR_PCT = 0;
export const SOFT_TAKE_PROFIT_PCT = 20;
export const SWING_TRAIL_PCT = 10;
export const ENTRY_DTE_MIN = 2;
export const ENTRY_DTE_MAX = 14;

/** Desk-facing snapshot of the locked swing law (health + tests).
 *  2–14 DTE is the non-LEAPS entry window. Long-call LEAPS (≥180 DTE) stay eligible. */
export const SWING_LAW = {
  hardStopPct: HARD_STOP_PCT,
  gainLockArmPct: GAIN_LOCK_ARM_PCT,
  gainLockFloorPct: GAIN_LOCK_FLOOR_PCT,
  softTakeProfitPct: SOFT_TAKE_PROFIT_PCT,
  trailPct: SWING_TRAIL_PCT,
  entryDteMin: ENTRY_DTE_MIN,
  entryDteMax: ENTRY_DTE_MAX,
  leapsEligible: true,
} as const;

/** Default band the monitor / factory inherit when a bot does not pin exits. */
export function swingExitBand(): ExitBand {
  return { tp: SOFT_TAKE_PROFIT_PCT, sl: HARD_STOP_PCT, trail: SWING_TRAIL_PCT };
}

/** Effective hard stop: bot may TIGHTEN below 10%, never loosen above it. sl<=0 → 10%. */
export function effectiveHardStop(bandSl: number): number {
  const n = Number(bandSl);
  if (!Number.isFinite(n) || !(n > 0)) return HARD_STOP_PCT;
  return Math.min(n, HARD_STOP_PCT);
}

// Back-compat aliases (analysis.ts / older comments). Same numbers as the gain-lock.
export const BREAKEVEN_ARM_PCT = GAIN_LOCK_ARM_PCT;
export const BREAKEVEN_FLOOR_PCT = GAIN_LOCK_FLOOR_PCT;

export const RATCHET_1 = { at: 60, trail: 30 };   // +60% peak → give back at most 30pts
export const RATCHET_2 = { at: 120, trail: 22 };  // +120% peak → give back at most 22pts

/** Trail width in effect for a given peak gain — tightens as the win grows. */
export function effectiveTrail(peakPct: number, baseTrail: number): number {
  if (baseTrail <= 0) return 0;
  if (peakPct >= RATCHET_2.at) return Math.min(baseTrail, RATCHET_2.trail);
  if (peakPct >= RATCHET_1.at) return Math.min(baseTrail, RATCHET_1.trail);
  return baseTrail;
}

/** Exit decision for a LONG position. `fav` = current gain % vs entry, `peak` = max gain % seen.
 *  Returns the exit reason, or null to keep holding. Identical in backtest and live.
 *  Hard stop + gain-lock always apply (full_auto does not wait for a human). */
export function exitReason(fav: number, peak: number, band: ExitBand): string | null {
  const sl = effectiveHardStop(band.sl);
  if (fav <= -sl) return 'stop-loss';
  if (peak >= GAIN_LOCK_ARM_PCT && fav <= GAIN_LOCK_FLOOR_PCT) return 'gain-lock';
  // Soft TP: book the ~20% goal when there is no trail. A live trail keeps riding.
  const tp = Number(band.tp) > 0 ? Number(band.tp) : 0;
  const trailActive = Number(band.trail) > 0;
  if (tp > 0 && fav >= tp && !trailActive) return 'take-profit';
  const t = effectiveTrail(peak, band.trail);
  // Trail does not fire until the gain-lock arm (+10% peak). Before that the
  // hard stop is the only giveback rule — a +6% fade is still a hold.
  if (t > 0 && peak >= GAIN_LOCK_ARM_PCT && fav <= peak - t) return 'trailing-stop';
  return null;
}

/** Time-based flatten. Non-LEAPS cannot hold overnight/weekend (bot overrides ignored).
 *  LEAPS hold through the close unless the bot explicitly sets hold_overnight/weekend false. */
export function overnightFlattenReason(opts: {
  nearClose: boolean;
  longGap: boolean;
  isLeaps: boolean;
  botHoldOvernight?: boolean | null;
  botHoldOverWeekend?: boolean | null;
  expiresToday?: boolean;
  maxHoldReason?: string | null;
}): string | null {
  if (!opts.nearClose) return null;
  if (opts.expiresToday) return 'flatten: contract expires today';
  if (opts.maxHoldReason) return opts.maxHoldReason;
  if (opts.isLeaps) {
    if (opts.botHoldOvernight === false) return 'flatten: no overnight';
    if (opts.longGap && opts.botHoldOverWeekend === false) return 'flatten: no weekend hold';
    return null;
  }
  if (opts.longGap) return 'flatten: no weekend hold';
  return 'flatten: no overnight';
}
