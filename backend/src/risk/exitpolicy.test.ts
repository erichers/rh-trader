import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  HARD_STOP_PCT,
  GAIN_LOCK_ARM_PCT,
  GAIN_LOCK_FLOOR_PCT,
  SOFT_TAKE_PROFIT_PCT,
  SWING_TRAIL_PCT,
  SWING_LAW,
  BREAKEVEN_ARM_PCT,
  BREAKEVEN_FLOOR_PCT,
  swingExitBand,
  effectiveHardStop,
  exitReason,
  overnightFlattenReason,
} from './exitpolicy.js';

describe('SWING_LAW constants (Eric locked)', () => {
  it('matches −10% hard stop / +10% arm / 0 floor / ~20% soft TP / trail 10', () => {
    assert.equal(HARD_STOP_PCT, 10);
    assert.equal(GAIN_LOCK_ARM_PCT, 10);
    assert.equal(GAIN_LOCK_FLOOR_PCT, 0);
    assert.equal(SOFT_TAKE_PROFIT_PCT, 20);
    assert.equal(SWING_TRAIL_PCT, 10);
    assert.equal(SWING_LAW.hardStopPct, 10);
    assert.equal(SWING_LAW.gainLockArmPct, 10);
    assert.equal(SWING_LAW.gainLockFloorPct, 0);
    assert.equal(SWING_LAW.softTakeProfitPct, 20);
    assert.equal(SWING_LAW.trailPct, 10);
    assert.equal(SWING_LAW.entryDteMin, 2);
    assert.equal(SWING_LAW.entryDteMax, 14);
    assert.equal(BREAKEVEN_ARM_PCT, GAIN_LOCK_ARM_PCT);
    assert.equal(BREAKEVEN_FLOOR_PCT, GAIN_LOCK_FLOOR_PCT);
  });

  it('default band is the swing law', () => {
    assert.deepEqual(swingExitBand(), { tp: 20, sl: 10, trail: 10 });
  });

  it('bot sl can tighten below 10% but cannot loosen above it', () => {
    assert.equal(effectiveHardStop(35), 10);
    assert.equal(effectiveHardStop(5), 5);
    assert.equal(effectiveHardStop(0), 10);
    assert.equal(effectiveHardStop(-1), 10);
  });
});

describe('exitReason — cut losers / winners ride', () => {
  const band = swingExitBand();

  it('cuts a loser at −10% even when the stored band sl is the old 35%', () => {
    assert.equal(exitReason(-10, 0, { tp: 20, sl: 35, trail: 40 }), 'stop-loss');
    assert.equal(exitReason(-9.9, 0, { tp: 20, sl: 35, trail: 40 }), null);
  });

  it('arms gain-lock at +10% and floors at 0 (never round-trip to a loss)', () => {
    assert.equal(exitReason(0, 10, band), 'gain-lock');
    assert.equal(exitReason(-0.1, 12, band), 'gain-lock');
    assert.equal(exitReason(0.1, 12, band), null); // still above floor
    assert.equal(exitReason(-1, 9.9, band), null); // not armed yet; not yet −10%
  });

  it('soft TP ~20% closes when there is no trail, else trail keeps riding after +10% peak', () => {
    assert.equal(exitReason(20, 20, { tp: 20, sl: 10, trail: 0 }), 'take-profit');
    assert.equal(exitReason(20, 20, { tp: 20, sl: 10, trail: SWING_TRAIL_PCT }), null); // ride
    assert.equal(exitReason(10, 20, { tp: 20, sl: 10, trail: SWING_TRAIL_PCT }), 'trailing-stop');
  });

  it('does not trail until peak >= +10% (gain-lock arm)', () => {
    // Old law trailed whenever peak > 0: peak 8 / trail 10 / fav −3 → trail.
    // New law holds — trail is dormant until the +10% arm.
    assert.equal(exitReason(-3, 8, { tp: 20, sl: 10, trail: 10 }), null);
    assert.equal(exitReason(1, 6, { tp: 20, sl: 10, trail: 4 }), null);
    assert.equal(exitReason(5, 15, { tp: 20, sl: 10, trail: 10 }), 'trailing-stop');
    assert.equal(exitReason(9.9, 9.9, { tp: 20, sl: 10, trail: 1 }), null); // peak not armed
    assert.equal(exitReason(9, 10, { tp: 20, sl: 10, trail: 1 }), 'trailing-stop');
  });

  it('full_auto path: loser closes without a human; winner is not capped at 20% with a trail', () => {
    assert.equal(exitReason(-10, 2, band), 'stop-loss');
    assert.equal(exitReason(40, 40, band), null);
  });
});

describe('overnightFlattenReason — no overnight except LEAPS', () => {
  it('flattens a non-LEAPS swing at the close even if the bot asked to hold', () => {
    assert.equal(overnightFlattenReason({
      nearClose: true, longGap: false, isLeaps: false, botHoldOvernight: true,
    }), 'flatten: no overnight');
    assert.equal(overnightFlattenReason({
      nearClose: true, longGap: true, isLeaps: false, botHoldOverWeekend: true,
    }), 'flatten: no weekend hold');
  });

  it('lets LEAPS ride overnight/weekend unless the bot explicitly opts out', () => {
    assert.equal(overnightFlattenReason({
      nearClose: true, longGap: true, isLeaps: true,
    }), null);
    assert.equal(overnightFlattenReason({
      nearClose: true, longGap: false, isLeaps: true, botHoldOvernight: false,
    }), 'flatten: no overnight');
  });

  it('always flattens an expiring contract', () => {
    assert.equal(overnightFlattenReason({
      nearClose: true, longGap: false, isLeaps: true, expiresToday: true,
    }), 'flatten: contract expires today');
  });
});
