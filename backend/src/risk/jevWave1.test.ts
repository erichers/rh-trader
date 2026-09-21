import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { exitReason } from './exitpolicy.js';
import { resolveMonitorExit } from './jevScope.js';
import {
  JEV_EXIT_CADENCE_EXPIRY_MS,
  JEV_EXIT_CADENCE_LEAPS_MS,
  JEV_EXIT_CADENCE_MEDIUM_MS,
  JEV_EXIT_CADENCE_SHORT_MS,
  JEV_EXIT_WAVE1_CANDIDATES,
  classifyJevExitWave1,
  jevExitArmError,
  jevExitCadenceWindowMs,
  jevExitFlagForWave,
  jevExitOrder,
  jevPartialRemain,
} from './jevWave1.js';

describe('Jev exit wave-1', () => {
  it('lists the arm candidates and keeps exit default off', () => {
    assert.deepEqual([...JEV_EXIT_WAVE1_CANDIDATES], [89, 12, 86, 25, 21, 39, 91, 92]);
    for (const id of JEV_EXIT_WAVE1_CANDIDATES) {
      const row = classifyJevExitWave1({ id, name: `bot ${id}`, action: { side: 'buy', option_type: 'call' } });
      assert.equal(row.mayArm, true, String(id));
      assert.equal(row.exitDefault, false);
      assert.equal(row.deferred, false);
    }
  });

  it('defers 0-DTE, Mag-7, covered-call observe, and speculative LEAPS', () => {
    assert.equal(classifyJevExitWave1({ id: 84, name: '0 DTE scalp', action: { side: 'buy' } }).mayArm, false);
    assert.match(classifyJevExitWave1({ id: 84, name: 'x', action: {} }).why, /0-DTE/);
    assert.match(classifyJevExitWave1({ id: 38, name: 'Mag-7 fleet', action: { side: 'buy', option_type: 'call' } }).why, /Mag-7/);
    assert.equal(classifyJevExitWave1({
      id: 89,
      name: 'covered call observe',
      action: { side: 'sell', option_type: 'call', _observe_only: true, covered: true },
    }).mayArm, false);
    assert.equal(classifyJevExitWave1({
      id: 12,
      name: 'speculative LEAPS',
      action: { side: 'buy', option_type: 'call', expiration: 'leaps' },
    }).mayArm, false);
    assert.equal(classifyJevExitWave1({ id: 7, name: 'other', action: { side: 'buy', option_type: 'call' } }).mayArm, false);
  });

  it('uses the RTH exit cadence and will not poll LEAPS faster than hourly', () => {
    assert.equal(jevExitCadenceWindowMs({ dte: 1 }), JEV_EXIT_CADENCE_SHORT_MS);
    assert.equal(jevExitCadenceWindowMs({ dte: 0, minutesToClose: 40 }), JEV_EXIT_CADENCE_EXPIRY_MS);
    assert.equal(jevExitCadenceWindowMs({ dte: 0, minutesToClose: 200 }), JEV_EXIT_CADENCE_SHORT_MS);
    assert.equal(jevExitCadenceWindowMs({ dte: 9 }), JEV_EXIT_CADENCE_MEDIUM_MS);
    assert.ok(JEV_EXIT_CADENCE_MEDIUM_MS >= 10 * 60 * 1000 && JEV_EXIT_CADENCE_MEDIUM_MS <= 15 * 60 * 1000);
    assert.equal(jevExitCadenceWindowMs({ dte: 120 }), JEV_EXIT_CADENCE_LEAPS_MS);
    assert.ok(JEV_EXIT_CADENCE_LEAPS_MS >= 60 * 60 * 1000);
  });

  it('CLOSE and PARTIAL only sell, and never clear gain-lock or widen the stop', () => {
    const close = jevExitOrder('exit', 4);
    const partial = jevExitOrder('partial', 4);
    assert.equal(close?.side, 'sell');
    assert.equal(close?.qty, 4);
    assert.equal(partial?.side, 'sell');
    assert.ok(partial && partial.qty < 4 && partial.qty >= 1);
    assert.equal(jevExitOrder('partial', 1), null);
    assert.equal(jevExitOrder('hold', 4), null);
    assert.equal(jevExitOrder('tighten', 4), null);

    const rail = exitReason(1.4, 12, { tp: 20, sl: 10, trail: 10 });
    assert.equal(rail, 'gain-lock');
    const kept = resolveMonitorExit({
      railReason: rail,
      jev: { pick: 'partial', applied: true },
      trailPct: 10,
      slPct: 10,
      tpPct: 20,
      fav: 1.4,
      peak: 12,
    });
    assert.equal(kept.reason, 'gain-lock');
    assert.equal(kept.slPct, 10);
    const tight = resolveMonitorExit({
      railReason: null,
      jev: { pick: 'tighten', applied: true },
      trailPct: 10,
      slPct: 10,
      tpPct: 20,
      fav: 4,
      peak: 6,
    });
    assert.ok(tight.trailPct < 10);
    assert.equal(tight.slPct, 10);
  });

  it('arms exit only for a paper wave-1 candidate and keeps a partial remainder', () => {
    assert.equal(jevExitArmError('alpaca_paper', { id: 89, name: 'call', action: { side: 'buy', option_type: 'call' } }), null);
    assert.match(jevExitArmError('alpaca_paper', { id: 84, name: '0 DTE', action: {} }) || '', /0-DTE/);
    assert.match(jevExitArmError('alpaca_paper', { id: 7, name: 'other', action: { side: 'buy' } }) || '', /not in exit wave-1/);
    assert.match(jevExitArmError('robinhood_live', { id: 89, name: 'call', action: { side: 'buy' } }) || '', /paper/);
    assert.equal(jevExitFlagForWave(true, { id: 89, name: 'call', action: { side: 'buy', option_type: 'call' } }), true);
    assert.equal(jevExitFlagForWave(true, { id: 84, name: '0 DTE', action: {} }), false);
    assert.equal(jevExitFlagForWave(false, { id: 89, name: 'call', action: { side: 'buy' } }), false);
    assert.deepEqual(jevPartialRemain(4, 2), { remain: 2, closeAll: false, applied: true });
    assert.equal(jevPartialRemain(4, 4).closeAll, true);
    assert.equal(jevPartialRemain(4, 0).applied, false);
  });
});
