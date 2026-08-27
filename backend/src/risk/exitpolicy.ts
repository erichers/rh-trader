// Shared exit policy — the ONE place that decides when a long position exits, used by BOTH
// the live monitor (risk/monitor.ts) and the backtest simulator (quickbot.ts). Keeping them
// identical is a hard rule: if backtest and live disagree, the backtest numbers are lies.
//
// Profile: POSITIVE SKEW (small losses, big wins), tuned from real trade history (2026-06-29/07-01,
// 25 round-trips): the flat wide trail (35–40pts) gave back ~40% of every peak and let a +30%
// winner round-trip to a loss. Fixes, in order of protection:
//   1. Fixed SMALL stop — cuts a wrong thesis fast.
//   2. BREAKEVEN LOCK — once a trade has been up ≥30%, it may never close negative (locks ≥ +1%).
//   3. RATCHETING TRAIL — wide early (let it run), tighter as the win grows:
//        peak <60%  → base trail (35–60 by DTE)
//        peak ≥60%  → trail tightens to ≤30
//        peak ≥120% → trail tightens to ≤22
//   4. Optional take-profit cap ONLY if explicitly set (tp>0). Default tp=0 = uncapped.

export type ExitBand = { tp: number; sl: number; trail: number };

export const BREAKEVEN_ARM_PCT = 30;  // a trade that reached +30%…
export const BREAKEVEN_FLOOR_PCT = 1; // …may never close below +1% (covers the spread)
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
 *  Returns the exit reason, or null to keep holding. Identical in backtest and live. */
export function exitReason(fav: number, peak: number, band: ExitBand): string | null {
  if (band.tp > 0 && fav >= band.tp) return 'take-profit';               // only if user set a cap
  if (band.sl > 0 && fav <= -band.sl) return 'stop-loss';                // small fixed stop
  if (peak >= BREAKEVEN_ARM_PCT && fav <= BREAKEVEN_FLOOR_PCT) return 'breakeven-lock';
  const t = effectiveTrail(peak, band.trail);
  if (t > 0 && peak > 0 && fav <= peak - t) return 'trailing-stop';      // ratcheting trail
  return null;
}
