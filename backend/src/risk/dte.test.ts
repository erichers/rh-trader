import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  calendarDte,
  dteToExpiration,
  entryDteAllowed,
  optionEntryDteCheck,
  pickListedExpiration,
  syncPlayDteToContract,
  isLeapsTrade,
  isShortDtePrivileged,
  LEAPS_DTE_MIN,
  SHORT_DTE_ALLOWLIST,
} from './dte.js';
import { applyFullAutoSoftBypass } from './law.js';
import { SHORT_DTE_BAND, SHORT_DTE_RAILS } from './shortdte.js';

const monday = new Date('2026-09-14T16:00:00-04:00'); // ET Monday
const thursday = new Date('2026-09-17T16:00:00-04:00'); // ET Thursday — the live-desk day
// SPY/QQQ-style daily + weeklies around that Thursday.
const CHAIN = [
  '2026-09-17', // 0DTE
  '2026-09-18', // 1DTE
  '2026-09-21', // 4DTE (Monday)
  '2026-09-22',
  '2026-09-23',
  '2026-09-24', // 7DTE
  '2026-09-25',
  '2026-09-28',
  '2026-09-30',
  '2026-10-01', // 14DTE
  '2026-10-02', // 15DTE — outside window
  '2026-12-18',
  '2027-03-19',
];

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

  it('vetoes play.dte alone — a 3/4/7 play cannot pass without a concrete expiration', () => {
    const g = optionEntryDteCheck({
      asset_class: 'option', side: 'buy', _play: { dte: 7 },
    }, thursday);
    assert.equal(g.ok, false);
    assert.equal(g.source, 'none');
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
      asset_class: 'option', side: 'buy', _contract: { expiration: '2026-09-21' }, _play: { dte: 7 },
    }, monday);
    assert.equal(week.ok, true);
    assert.equal(week.dte, 7);
    assert.equal(week.source, 'contract');

    const leaps = optionEntryDteCheck({
      asset_class: 'option',
      side: 'buy',
      expiration: 'leaps',
      name: 'MU LEAPS core',
    }, monday);
    assert.equal(leaps.ok, true);
    assert.equal(leaps.leaps, true);

    // Far ISO date with no "LEAPS" in the name is still a LEAPS (≥180 DTE).
    const far = optionEntryDteCheck({
      asset_class: 'option',
      side: 'buy',
      option_type: 'call',
      _contract: { expiration: '2027-03-19' },
    } as any, monday);
    assert.equal(far.ok, true);
    assert.equal(far.leaps, true);
    assert.ok((far.dte ?? 0) >= LEAPS_DTE_MIN);

    // Mid-dated unlabeled call is still outside the 2–14 window.
    const mid = optionEntryDteCheck({
      asset_class: 'option',
      side: 'buy',
      _contract: { expiration: '2026-10-30' },
    }, monday);
    assert.equal(mid.ok, false);
    assert.equal(mid.leaps, false);
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

describe('default bots reject 0–1 DTE even when play.dte says 3/4/7', () => {
  it('vetoes a 1DTE contract while _play.dte is 3 (the Sep 17 desk bug)', () => {
    const g = optionEntryDteCheck({
      asset_class: 'option',
      side: 'buy',
      key: 'momo_up',
      _play: { dte: 3, name: 'CALL Up-momentum · 3DTE' },
      _contract: { expiration: '2026-09-18' },
    }, thursday);
    assert.equal(g.ok, false);
    assert.equal(g.dte, 1);
    assert.equal(g.privileged, false);
    assert.match(g.detail, /1DTE blocked/);
  });

  it('vetoes a 1DTE contract while _play.dte is 7', () => {
    const g = optionEntryDteCheck({
      asset_class: 'option', side: 'buy', _play: { dte: 7 }, _contract: { expiration: '2026-09-18' },
    }, thursday);
    assert.equal(g.ok, false);
    assert.equal(g.dte, 1);
  });

  it('a lone allow_0_1_dte flag does not grant 0–1 (must be on the allowlist)', () => {
    const g = optionEntryDteCheck({
      asset_class: 'option',
      side: 'buy',
      key: 'momo_up',
      allow_0_1_dte: true,
      _play: { dte: 1, sl: 5, tp: 10, allow_0_1_dte: true },
      _contract: { expiration: '2026-09-18' },
    }, thursday);
    assert.equal(g.ok, false);
    assert.equal(g.privileged, false);
  });
});

describe('allowlisted high-certainty bots — 0–1 only with tight SL/TP', () => {
  it('lists the two privileged keys', () => {
    const keys = SHORT_DTE_ALLOWLIST.map((r) => r.key);
    assert.deepEqual(keys, ['ai-catalyst-call', 'accel_dual_momentum_call']);
    assert.equal(isShortDtePrivileged({ key: 'ai-catalyst-call' }), true);
    assert.equal(isShortDtePrivileged({ key: 'momo_up' }), false);
  });

  it('accepts 1DTE for AI Catalyst with tight rails', () => {
    const g = optionEntryDteCheck({
      asset_class: 'option',
      side: 'buy',
      key: 'ai-catalyst-call',
      name: 'AI Catalyst — Long Call',
      _play: { key: 'ai-catalyst-call', dte: 1, sl: 5, tp: 10, trail: 4, maxPositionUsd: 400 },
      _contract: { expiration: '2026-09-18' },
    }, thursday);
    assert.equal(g.ok, true);
    assert.equal(g.dte, 1);
    assert.equal(g.privileged, true);
  });

  it('accepts 0DTE for dual-horizon momentum with tight rails', () => {
    const g = optionEntryDteCheck({
      asset_class: 'option',
      side: 'buy',
      key: 'accel_dual_momentum_call',
      _play: { ...SHORT_DTE_BAND, key: 'accel_dual_momentum_call', dte: 0, maxPositionUsd: SHORT_DTE_BAND.max_position_usd },
      _contract: { expiration: '2026-09-17' },
    }, thursday);
    assert.equal(g.ok, true);
    assert.equal(g.dte, 0);
    assert.equal(g.privileged, true);
  });

  it('vetoes an allowlisted 1DTE buy with loose swing-law SL/TP', () => {
    const g = optionEntryDteCheck({
      asset_class: 'option',
      side: 'buy',
      key: 'ai-catalyst-call',
      _play: { key: 'ai-catalyst-call', dte: 1, sl: 10, tp: 25, trail: 12, maxPositionUsd: 2000 },
      _contract: { expiration: '2026-09-18' },
    }, thursday);
    assert.equal(g.ok, false);
    assert.equal(g.privileged, true);
    assert.match(g.detail, /stop|take-profit|size|rails/i);
  });

  it('vetoes an allowlisted 1DTE buy with tp=0 (no “let it run”)', () => {
    const g = optionEntryDteCheck({
      asset_class: 'option',
      side: 'buy',
      key: 'accel_dual_momentum_call',
      _play: { key: 'accel_dual_momentum_call', sl: 5, tp: 0, trail: 4 },
      _contract: { expiration: '2026-09-18' },
    }, thursday);
    assert.equal(g.ok, false);
    assert.match(g.detail, /take-profit|let it run/i);
  });

  it('still requires a concrete expiration for allowlisted bots (fail-closed)', () => {
    const g = optionEntryDteCheck({
      asset_class: 'option',
      side: 'buy',
      key: 'ai-catalyst-call',
      _play: { key: 'ai-catalyst-call', dte: 1, sl: 5, tp: 10 },
    }, thursday);
    assert.equal(g.ok, false);
    assert.match(g.detail, /unresolved/);
  });
});

describe('contract selection prefers 2–14 DTE and matches play vs expiration', () => {
  it('dteToExpiration is ET calendar days (play.dte=3 on Thu → Sep 20)', () => {
    assert.equal(dteToExpiration(3, thursday), '2026-09-20');
    assert.equal(dteToExpiration(1, thursday), '2026-09-18');
    assert.equal(dteToExpiration(7, thursday), '2026-09-24');
  });

  it('normal weekly/3DTE pick never lands on Sep 18 (1DTE)', () => {
    const exp = pickListedExpiration(CHAIN, { pref: 'weekly', targetDte: 3, now: thursday });
    assert.ok(exp);
    assert.notEqual(exp, '2026-09-18');
    assert.notEqual(exp, '2026-09-17');
    const dte = calendarDte(exp!, thursday)!;
    assert.ok(dte >= 2 && dte <= 14);
    // closest listed to 3 DTE is Monday Sep 21 (4)
    assert.equal(exp, '2026-09-21');
  });

  it('a past baked ISO date does not snap onto tomorrow’s daily expiry', () => {
    const exp = pickListedExpiration(CHAIN, { pref: '2026-06-26', now: thursday });
    assert.ok(exp);
    assert.notEqual(exp, '2026-09-18');
    assert.ok(calendarDte(exp!, thursday)! >= 2);
  });

  it('target 7 DTE picks the listed 7 DTE Friday', () => {
    assert.equal(pickListedExpiration(CHAIN, { pref: 'weekly', targetDte: 7, now: thursday }), '2026-09-24');
  });

  it('monthly prefers 14 DTE', () => {
    assert.equal(pickListedExpiration(CHAIN, { pref: 'monthly', now: thursday }), '2026-10-01');
  });

  it('allowlisted 1 DTE may pick Sep 18', () => {
    assert.equal(
      pickListedExpiration(CHAIN, { pref: '2026-09-18', targetDte: 1, allowShortDte: true, now: thursday }),
      '2026-09-18',
    );
  });

  it('normal bots cannot pick 0–1 even when the ISO pref is tomorrow', () => {
    const exp = pickListedExpiration(CHAIN, { pref: '2026-09-18', targetDte: 1, now: thursday });
    assert.ok(exp);
    assert.notEqual(exp, '2026-09-18');
    assert.ok(calendarDte(exp!, thursday)! >= 2);
  });

  it('LEAPS still pick the far date', () => {
    assert.equal(pickListedExpiration(CHAIN, { pref: 'leaps', now: thursday }), '2027-03-19');
    assert.equal(pickListedExpiration(CHAIN, { pref: '2027-03-19', name: 'MU LEAPS core', now: thursday }), '2027-03-19');
  });

  it('syncPlayDteToContract rewrites play.dte to the selected expiration', () => {
    const draft = {
      expiration: '2026-09-20',
      _play: { dte: 3, name: 'CALL 3DTE' },
      _contract: { expiration: '2026-09-21' },
    };
    syncPlayDteToContract(draft, thursday);
    assert.equal(draft._play.dte, 4);
    assert.equal(draft.expiration, '2026-09-21');
    assert.equal(calendarDte(draft._contract.expiration, thursday), draft._play.dte);
  });

  it('returns null (fail-closed) when the chain has nothing in the window', () => {
    assert.equal(pickListedExpiration(['2026-09-17', '2026-09-18'], { pref: 'weekly', now: thursday }), null);
  });
});

describe('short-DTE rails constants', () => {
  it('are tighter than the swing-law 10/20 band', () => {
    assert.ok(SHORT_DTE_RAILS.slMax <= 5);
    assert.ok(SHORT_DTE_RAILS.tpMax <= 12);
    assert.ok(SHORT_DTE_RAILS.tpMin >= 6);
    assert.ok(SHORT_DTE_RAILS.maxPositionUsd <= 400);
  });
});
