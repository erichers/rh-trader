import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { exitPulse } from './exitPulse.ts';

const law = { hardStopPct: 10, gainLockArmPct: 10, gainLockFloorPct: 1.5, trailPct: 10 };

describe('exit pulse', () => {
  it('uses the swing-law hard stop when the bot stop is looser', () => {
    const p = exitPulse({ entry_price: 100, last_price: 90, peak_price: 100, sl_pct: 35, trail_pct: 40 }, law);
    assert.equal(p.label, 'Hard stop');
    assert.equal(p.tone, 'red');
    assert.match(p.title, /hard stop 10%/);
  });

  it('calls gain-lock when a +10% winner fades to the +1.5% floor', () => {
    const p = exitPulse({ entry_price: 100, last_price: 101.4, peak_price: 112, sl_pct: 10, trail_pct: 10 }, law);
    assert.equal(p.label, 'Gain-lock');
    assert.equal(p.tone, 'red');
  });

  it('paints a stuck sell red even if the mark is fine', () => {
    const p = exitPulse({ entry_price: 100, last_price: 110, peak_price: 110, pending_exit_order_id: 44, reason: 'EXIT STUCK [exiting]' }, law);
    assert.equal(p.label, 'Stuck sell');
    assert.equal(p.tone, 'red');
  });

  it('holds a small green trade before the gain-lock arms', () => {
    const p = exitPulse({ entry_price: 100, last_price: 106, peak_price: 106, sl_pct: 10, trail_pct: 10 }, law);
    assert.equal(p.label, 'Holding');
    assert.equal(p.tone, 'muted');
    assert.equal(p.label.includes('—'), false);
  });
});
