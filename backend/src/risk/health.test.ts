import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { healthVerdict } from './health.js';
import { SWING_LAW } from './exitpolicy.js';
import { museWatchLamp } from '../muse/watch.js';

describe('healthVerdict', () => {
  it('is ready only when db + alpaca_paper + alpaca reachable', () => {
    const v = healthVerdict({
      db: true,
      env: 'alpaca_paper',
      live: false,
      alpaca: { ok: true, configured: true },
    });
    assert.equal(v.paper, true);
    assert.equal(v.ready, true);
    assert.deepEqual(v.failures, []);
  });

  it('names db_down when MySQL is gone (API process can still answer)', () => {
    const v = healthVerdict({
      db: false,
      env: 'alpaca_paper',
      live: false,
      alpaca: { ok: true, configured: true },
    });
    assert.equal(v.ready, false);
    assert.ok(v.failures.includes('db_down'));
  });

  it('names alpaca_not_configured vs alpaca_unreachable', () => {
    const missing = healthVerdict({
      db: true, env: 'alpaca_paper', live: false,
      alpaca: { ok: false, configured: false },
    });
    assert.ok(missing.failures.includes('alpaca_not_configured'));
    assert.equal(missing.ready, false);

    const down = healthVerdict({
      db: true, env: 'alpaca_paper', live: false,
      alpaca: { ok: false, configured: true },
    });
    assert.ok(down.failures.includes('alpaca_unreachable'));
    assert.equal(down.ready, false);
  });

  it('refuses robinhood_live even if db and alpaca look fine', () => {
    const v = healthVerdict({
      db: true,
      env: 'robinhood_live',
      live: true,
      alpaca: { ok: true, configured: true },
    });
    assert.equal(v.paper, false);
    assert.equal(v.ready, false);
    assert.ok(v.failures.includes('live_env'));
    assert.ok(v.failures.includes('not_paper'));
  });
});

describe('SWING_LAW /api/health snapshot', () => {
  it('is 10 / 10 / 0 / 20 / 10 / dte 2–14', () => {
    assert.deepEqual(SWING_LAW, {
      hardStopPct: 10,
      gainLockArmPct: 10,
      gainLockFloorPct: 0,
      softTakeProfitPct: 20,
      trailPct: 10,
      entryDteMin: 2,
      entryDteMax: 14,
      leapsEligible: true,
    });
  });
});

describe('health.watch lamp', () => {
  it('Muse down is unknown, not green', () => {
    const lamp = museWatchLamp({
      configured: false, running: true, lastCycle: 'x', lastError: null,
    });
    assert.equal(lamp.ok, false);
    assert.equal(lamp.available, false);
    assert.equal(lamp.observeOnly, true);
  });
});
