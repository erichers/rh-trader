import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { museAuditLocal } from './auditor.js';
import { museWatchLamp, resetMuseWatchForTests, runMuseWatchCycle } from './watch.js';

describe('museWatchLamp — never green when Muse is down', () => {
  it('unconfigured → available false, ok false (unknown, not green)', () => {
    const lamp = museWatchLamp({
      configured: false,
      running: false,
      lastCycle: null,
      lastError: null,
    });
    assert.equal(lamp.available, false);
    assert.equal(lamp.ok, false);
    assert.equal(lamp.observeOnly, true);
    assert.equal(lamp.running, false);
    assert.match(lamp.note, /never green/i);
  });

  it('configured but lastError → not green', () => {
    const lamp = museWatchLamp({
      configured: true,
      running: false,
      lastCycle: '2026-09-21T12:00:00.000Z',
      lastError: 'muse 401',
    });
    assert.equal(lamp.available, true);
    assert.equal(lamp.ok, false);
    assert.equal(lamp.observeOnly, true);
    assert.match(lamp.note, /unknown/);
  });

  it('configured + lastCycle + no error → ok', () => {
    const lamp = museWatchLamp({
      configured: true,
      running: false,
      lastCycle: '2026-09-21T12:00:00.000Z',
      lastError: null,
    });
    assert.equal(lamp.ok, true);
    assert.equal(lamp.available, true);
    assert.equal(lamp.observeOnly, true);
  });
});

describe('runMuseWatchCycle', () => {
  it('counts positions and armed bots and never submits', async () => {
    resetMuseWatchForTests();
    const cycle = await runMuseWatchCycle({
      env: 'alpaca_paper',
      loadPositions: async () => [{ symbol: 'TSLA' }, { symbol: 'QQQ' }],
      loadBots: async () => [
        { name: 'LEAPS momo', enabled: 1, mode: 'full_auto', action: { _strategy: 'leaps-call' } },
        { name: 'Mean-Revert Watch', enabled: 1, mode: 'observe', action: { _observe_only: true } },
      ],
      now: () => '2026-09-21T16:00:00.000Z',
    });
    assert.equal(cycle.positions, 2);
    assert.equal(cycle.armedBots, 1);
    assert.equal(cycle.error, null);
    assert.equal(cycle.at, '2026-09-21T16:00:00.000Z');
  });
});

describe('museAuditLocal', () => {
  it('never marks submitted and can recommend soft_block', () => {
    const ok = museAuditLocal({
      symbol: 'QQQ', why: 'Fired: EMA9 crosses above EMA21.', riskOk: true,
      checks: { entry_dte: { pass: true, detail: '7DTE' } },
    });
    assert.equal(ok.submitted, false);
    assert.equal(ok.flag, 'ok');

    const stale = museAuditLocal({
      symbol: 'NVDA', why: 'EMA9 140 already > EMA21 138 (no fresh cross)', riskOk: true,
      checks: { entry_dte: { pass: true, detail: '7DTE' } },
    });
    assert.equal(stale.submitted, false);
    assert.equal(stale.flag, 'soft_block');

    const hard = museAuditLocal({
      symbol: 'META', why: 'Fired', riskOk: false,
      checks: { puts_blocked: { pass: false, detail: 'puts_blocked' } },
    });
    assert.equal(hard.flag, 'note');
    assert.match(hard.because, /will not place/);
  });
});
