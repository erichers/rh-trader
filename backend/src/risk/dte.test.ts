import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  calendarDte,
  entryDteAllowed,
  optionEntryDteCheck,
  isLeapsTrade,
  LEAPS_DTE_MIN,
} from './dte.js';
import { applyFullAutoSoftBypass } from './law.js';

const monday = new Date('2026-09-14T16:00:00-04:00'); // ET Monday

describe('option entry DTE window', () => {
  it('blocks 0DTE and 1DTE buys', () => {
    assert.equal(entryDteAllowed(0, false).ok, false);
    assert.equal(entryDteAllowed(1, false).ok, false);
    assert.match(entryDteAllowed(0, false).detail, /0DTE|1DTE|blocked/);
  });

  it('allows 2–14 DTE and rejects 15+', () => {
    assert.equal(entryDteAllowed(2, false).ok, true);
    assert.equal(entryDteAllowed(14, false).ok, true);
    assert.equal(entryDteAllowed(15, false).ok, false);
    assert.equal(entryDteAllowed(32, false).ok, false);
  });

  it('vetoes an unresolved option buy (fail-closed — cannot prove not 0DTE)', () => {
    const g = optionEntryDteCheck({
      asset_class: 'option', side: 'buy', expiration: 'weekly',
    }, monday);
    assert.equal(g.ok, false);
    assert.match(g.detail, /unresolved|0DTE/);
  });

  it('blocks a 0DTE contract even under full_auto (DTE is not a soft bypass)', () => {
    const dte = optionEntryDteCheck({
      asset_class: 'option',
      side: 'buy',
      _contract: { expiration: '2026-09-14' }, // same ET day → 0DTE
    }, monday);
    assert.equal(dte.ok, false);
    assert.equal(dte.dte, 0);
    const soft = applyFullAutoSoftBypass({
      mode: 'full_auto',
      aggregatePositionOk: true,
      concentrationOk: true,
      throttleOk: false,
    });
    // full_auto may skip orders/day only — DTE + book still bind
    assert.equal(soft.sizeOk, true);
    assert.equal(soft.throttleBypassed, true);
    assert.equal(dte.ok, false);
  });

  it('allows a 7DTE contract and a LEAPS far date', () => {
    const week = optionEntryDteCheck({
      asset_class: 'option', side: 'buy', _play: { dte: 7 },
    }, monday);
    assert.equal(week.ok, true);
    assert.equal(week.dte, 7);

    const leaps = optionEntryDteCheck({
      asset_class: 'option',
      side: 'buy',
      expiration: 'leaps',
      name: 'MU LEAPS core',
    }, monday);
    assert.equal(leaps.ok, true);
    assert.equal(leaps.leaps, true);
  });

  it('does not apply the window to sells or shares', () => {
    assert.equal(optionEntryDteCheck({ asset_class: 'option', side: 'sell', _play: { dte: 0 } }, monday).ok, true);
    assert.equal(optionEntryDteCheck({ asset_class: 'equity', side: 'buy' }, monday).ok, true);
  });

  it('calendarDte treats ET today as 0 and a date 180+ days out as LEAPS', () => {
    assert.equal(calendarDte('2026-09-14', monday), 0);
    assert.equal(calendarDte('2026-09-15', monday), 1);
    assert.equal(calendarDte('2026-09-21', monday), 7);
    assert.ok(isLeapsTrade({ expiration: '2027-03-19', now: monday }));
    assert.ok(LEAPS_DTE_MIN >= 180);
  });
});
