import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  mapBrokerOrderStatus,
  exitPlacementOutcome,
  heldZeroDecision,
  shouldRetryStuckNew,
  clampExitPolicy,
  isCorruptedSettingsObject,
  parsePendingExitOrderId,
  exitingReason,
  EXIT_POLICY_DEFAULTS,
  STUCK_NEW_MS,
  MAX_EXIT_ATTEMPTS,
} from './exitlifecycle.js';
import { applyFullAutoSoftBypass } from './law.js';
import { SWING_LAW } from './exitpolicy.js';

describe('exitPlacementOutcome — do not close monitor on new/placed', () => {
  it('NVDA replay: local status new / placed is pending, not a fill', () => {
    assert.equal(exitPlacementOutcome({ status: 'new' }), 'pending');
    assert.equal(exitPlacementOutcome({ status: 'placed' }), 'pending');
    assert.equal(exitPlacementOutcome({ status: 'accepted' }), 'pending');
    assert.equal(mapBrokerOrderStatus('new'), 'new');
  });

  it('only a terminal fill closes the monitor', () => {
    assert.equal(exitPlacementOutcome({ status: 'filled', fillPrice: 12.4, filledQty: 1, orderQty: 1 }), 'filled');
    assert.equal(exitPlacementOutcome({ status: 'vetoed' }), 'failed');
    assert.equal(exitPlacementOutcome({ status: 'rejected' }), 'failed');
    assert.equal(exitPlacementOutcome({ status: 'canceled' }), 'failed');
  });

  it('fillPrice alone on a new order is not enough (qty still locked at broker)', () => {
    assert.equal(exitPlacementOutcome({ status: 'new', fillPrice: 7.1 }), 'pending');
  });
});

describe('heldZeroDecision — orphan once, no zombie sells', () => {
  it('orphans immediately when held=0 and the exact book is flat', () => {
    assert.equal(heldZeroDecision({ heldQty: 0, exactOpenQty: 0, pendingExit: false }), 'orphan');
  });

  it('does not place another sell while a pending exit is locking qty', () => {
    assert.equal(heldZeroDecision({ heldQty: 0, exactOpenQty: 0, pendingExit: true }), 'wait');
    assert.equal(heldZeroDecision({ heldQty: 0, exactOpenQty: 5, pendingExit: false }), 'wait');
  });

  it('keeps a real long', () => {
    assert.equal(heldZeroDecision({ heldQty: 2, exactOpenQty: 2, pendingExit: false }), 'keep');
  });
});

describe('shouldRetryStuckNew — cancel+retry then escalate', () => {
  it('waits while the order is young', () => {
    assert.equal(shouldRetryStuckNew({ ageMs: 10_000, attempts: 1, status: 'new' }), 'wait');
  });

  it('cancels and retries after the stuck window', () => {
    assert.equal(shouldRetryStuckNew({ ageMs: STUCK_NEW_MS + 1, attempts: 1, status: 'new' }), 'cancel_retry');
  });

  it('escalates after max attempts (no more spam)', () => {
    assert.equal(shouldRetryStuckNew({
      ageMs: STUCK_NEW_MS + 1, attempts: MAX_EXIT_ATTEMPTS, status: 'new',
    }), 'escalate');
  });
});

describe('clampExitPolicy — rewrite exploded/corrupt JSON', () => {
  it('rewrites a string exploded into char keys', () => {
    const exploded: Record<string, string> = {};
    '{"holdOvernight":true,"junk":1}'.split('').forEach((ch, i) => { exploded[String(i)] = ch; });
    assert.equal(isCorruptedSettingsObject(exploded, ['holdOvernight', 'holdOverWeekend', 'closeBufferMin']), true);
    const { policy, rewritten } = clampExitPolicy(exploded);
    assert.equal(rewritten, true);
    assert.deepEqual(policy, {
      holdOvernight: false,
      holdOverWeekend: false,
      closeBufferMin: 15,
    });
  });

  it('rewrites a raw string and keeps a clean object', () => {
    assert.deepEqual(clampExitPolicy('not-json').policy, EXIT_POLICY_DEFAULTS);
    const clean = clampExitPolicy({ holdOvernight: true, holdOverWeekend: false, closeBufferMin: 20 });
    assert.equal(clean.rewritten, false);
    assert.equal(clean.policy.holdOvernight, true);
    assert.equal(clean.policy.closeBufferMin, 20);
  });
});

describe('pending-exit reason tag', () => {
  it('round-trips the local order id (NVDA 7117001 shape)', () => {
    const r = exitingReason(7117001, 'stop-loss');
    assert.equal(parsePendingExitOrderId(r), 7117001);
    assert.equal(parsePendingExitOrderId('EXIT FAILED', 42), 42);
  });
});

describe('full_auto rails stay hard (Mac hotfix / PR#9)', () => {
  it('still cannot bypass size or concentration', () => {
    const g = applyFullAutoSoftBypass({
      mode: 'full_auto',
      aggregatePositionOk: false,
      concentrationOk: false,
      throttleOk: false,
    });
    assert.equal(g.sizeOk, false);
    assert.equal(g.concentrationOk, false);
    assert.equal(g.throttleBypassed, true);
  });

  it('swing law matches live session ask', () => {
    assert.equal(SWING_LAW.hardStopPct, 10);
    assert.equal(SWING_LAW.gainLockArmPct, 10);
    assert.equal(SWING_LAW.gainLockFloorPct, 1.5);
    assert.equal(SWING_LAW.softTakeProfitPct, 20);
    assert.equal(SWING_LAW.trailPct, 10);
    assert.equal(SWING_LAW.entryDteMin, 2);
    assert.equal(SWING_LAW.entryDteMax, 14);
    assert.equal(SWING_LAW.leapsEligible, true);
  });
});
