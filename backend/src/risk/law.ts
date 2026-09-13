import type { Mode } from '../config.js';

/**
 * Desk risk law for Monday paper (and later live). These are hard ceilings —
 * UI / .env / bot override cannot raise them, and full_auto cannot bypass them.
 */
export const RISK_LAW = {
  /** Max USD for one ticket AND the combined same-symbol book across bots. */
  maxTradeUsd: 10_000,
  /** Daily-loss breaker must trip at or before this drawdown. */
  maxDailyDrawdownPct: 50,
} as const;

export function clampRiskLawPositionUsd(v: number, fallback: number): number {
  const n = Number(v);
  if (!Number.isFinite(n) || !(n > 0)) return Math.min(RISK_LAW.maxTradeUsd, fallback);
  return Math.min(RISK_LAW.maxTradeUsd, Math.max(50, n));
}

export function clampRiskLawDailyLossPct(v: number, fallback: number): number {
  const n = Number(v);
  if (!Number.isFinite(n) || !(n > 0)) return Math.min(RISK_LAW.maxDailyDrawdownPct, fallback);
  return Math.min(RISK_LAW.maxDailyDrawdownPct, Math.max(1, n));
}

export type SoftGate = {
  sizeOk: boolean;
  concentrationOk: boolean;
  throttleOk: boolean;
  sizeBypassed: boolean;
  concentrationBypassed: boolean;
  throttleBypassed: boolean;
};

/**
 * What full_auto is allowed to ignore.
 *
 * Historical bug: full_auto treated max-position and 25% concentration as "soft"
 * and the META stack (Donchian + Momentum Day + Opening Range) slipped past the
 * $10k book. Those are now hard rails in every mode.
 *
 * The only remaining soft throttle is orders/day. Monday default is still `auto`
 * so that throttle stays on.
 */
export function applyFullAutoSoftBypass(opts: {
  mode?: Mode | string;
  aggregatePositionOk: boolean;
  concentrationOk: boolean;
  concFailClosed?: boolean;
  throttleOk: boolean;
}): SoftGate {
  const fullAuto = opts.mode === 'full_auto';
  // Size + concentration are risk-law rails. Never bypass, including full_auto
  // and including the live-equity fail-closed path.
  return {
    sizeOk: opts.aggregatePositionOk,
    concentrationOk: opts.concentrationOk,
    throttleOk: opts.throttleOk || fullAuto,
    sizeBypassed: false,
    concentrationBypassed: false,
    throttleBypassed: !opts.throttleOk && fullAuto,
  };
}

/** Monday recommendation: auto. full_auto only skips the orders/day throttle. */
export const MONDAY_DEFAULT_MODE: Mode = 'auto';
