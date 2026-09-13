import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  RISK_LAW,
  clampRiskLawPositionUsd,
  clampRiskLawDailyLossPct,
  applyFullAutoSoftBypass,
  MONDAY_DEFAULT_MODE,
} from './law.js';

describe('RISK_LAW', () => {
  it('is $10k per trade / same-symbol book and 50% daily breaker', () => {
    assert.equal(RISK_LAW.maxTradeUsd, 10_000);
    assert.equal(RISK_LAW.maxDailyDrawdownPct, 50);
  });

  it('clamps a bot override that tries to disable the $10k cap', () => {
    assert.equal(clampRiskLawPositionUsd(1_000_000_000, 2000), 10_000);
    assert.equal(clampRiskLawPositionUsd(4500, 2000), 4500);
    assert.equal(clampRiskLawPositionUsd(0, 2000), 2000);
  });

  it('clamps daily-loss so a bot cannot set 100%', () => {
    assert.equal(clampRiskLawDailyLossPct(100, 3), 50);
    assert.equal(clampRiskLawDailyLossPct(3, 3), 3);
  });
});

describe('applyFullAutoSoftBypass — META stack / concentration', () => {
  const stackedFail = {
    aggregatePositionOk: false, // 4.5k+4.5k+4.5k > $10k book
    concentrationOk: true,
    throttleOk: true,
  };

  it('auto vetoes a same-symbol book over $10k', () => {
    const g = applyFullAutoSoftBypass({ mode: 'auto', ...stackedFail });
    assert.equal(g.sizeOk, false);
    assert.equal(g.sizeBypassed, false);
  });

  it('full_auto also vetoes the same-symbol book (does not bypass)', () => {
    const g = applyFullAutoSoftBypass({ mode: 'full_auto', ...stackedFail });
    assert.equal(g.sizeOk, false);
    assert.equal(g.sizeBypassed, false);
    assert.equal(g.concentrationBypassed, false);
  });

  it('full_auto also holds the 25% concentration rail', () => {
    const g = applyFullAutoSoftBypass({
      mode: 'full_auto',
      aggregatePositionOk: true,
      concentrationOk: false,
      throttleOk: true,
    });
    assert.equal(g.concentrationOk, false);
    assert.equal(g.concentrationBypassed, false);
  });

  it('full_auto may still bypass only the orders/day throttle', () => {
    const g = applyFullAutoSoftBypass({
      mode: 'full_auto',
      aggregatePositionOk: true,
      concentrationOk: true,
      throttleOk: false,
    });
    assert.equal(g.throttleOk, true);
    assert.equal(g.throttleBypassed, true);
  });

  it('auto does not bypass orders/day', () => {
    const g = applyFullAutoSoftBypass({
      mode: 'auto',
      aggregatePositionOk: true,
      concentrationOk: true,
      throttleOk: false,
    });
    assert.equal(g.throttleOk, false);
    assert.equal(g.throttleBypassed, false);
  });

  it('Monday default mode is auto (throttle stays on)', () => {
    assert.equal(MONDAY_DEFAULT_MODE, 'auto');
  });
});
