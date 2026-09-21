import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { STRATEGY_LIBRARY, shouldSeedStrategy } from '../bots/strategies.js';
import {
  CALLS_ONLY_REASON,
  PUTS_BLOCKED_REASON,
  callsOnlyBuyCheck,
  convertEquityDraftToCall,
  isFullAutoPaper,
  shouldConvertEquityBot,
  type CallsOnlyHint,
} from './callsonly.js';

const paperAuto = { mode: 'full_auto' as const, env: 'alpaca_paper' as const };

describe('callsOnlyBuyCheck — full_auto paper', () => {
  it('lets a long-call LEAPS through (far DTE is intentional)', () => {
    const v = callsOnlyBuyCheck({
      side: 'buy',
      asset_class: 'option',
      option_type: 'call',
      expiration: '2027-03-19',
      name: 'MU LEAPS core',
      _play: { dte: 182, key: 'leaps-call', name: 'MU LEAPS core' },
    }, paperAuto);
    assert.equal(v.pass, true);
    assert.equal(v.convertToCall, false);
    assert.match(v.detail, /LEAPS/);
  });

  it('lets a 2–14 DTE call through', () => {
    const v = callsOnlyBuyCheck({
      side: 'buy', asset_class: 'option', option_type: 'call', expiration: 'weekly',
    }, paperAuto);
    assert.equal(v.pass, true);
    assert.equal(v.convertToCall, false);
  });

  it('vetoes a put buy with puts_blocked', () => {
    const v = callsOnlyBuyCheck({
      side: 'buy', asset_class: 'option', option_type: 'put',
    }, paperAuto);
    assert.equal(v.pass, false);
    assert.equal(v.reason, PUTS_BLOCKED_REASON);
    assert.match(v.detail, /puts_blocked/);
  });

  it('vetoes a QuickBot put tagged on _play', () => {
    const v = callsOnlyBuyCheck({
      side: 'buy', asset_class: 'option', _play: { tag: 'put-7', dte: 7 },
    }, paperAuto);
    assert.equal(v.pass, false);
    assert.equal(v.reason, PUTS_BLOCKED_REASON);
  });

  it('refuses an equity buy — never convert', () => {
    const v = callsOnlyBuyCheck({
      side: 'buy', asset_class: 'equity', qty: 13, est_price: 721.36,
    }, paperAuto);
    assert.equal(v.pass, false);
    assert.equal(v.reason, CALLS_ONLY_REASON);
    assert.equal(v.convertToCall, false);
    assert.match(v.detail, /refused/);
  });

  it('does not bind sells or non-full_auto modes', () => {
    assert.equal(callsOnlyBuyCheck({
      side: 'sell', asset_class: 'option', option_type: 'put',
    }, paperAuto).pass, true);
    assert.equal(callsOnlyBuyCheck({
      side: 'buy', asset_class: 'equity',
    }, { mode: 'auto', env: 'alpaca_paper' }).pass, true);
    assert.equal(callsOnlyBuyCheck({
      side: 'buy', asset_class: 'option', option_type: 'put',
    }, { mode: 'full_auto', env: 'robinhood_live', live: true }).pass, true);
  });
});

describe('convertEquityDraftToCall', () => {
  it('refuses to rewrite a Friday-style ORB equity lot into a call', () => {
    const d = convertEquityDraftToCall({
      side: 'buy',
      asset_class: 'equity',
      qty: 13,
      est_price: 721.36,
    } as CallsOnlyHint);
    assert.equal(d.asset_class, 'equity');
    assert.equal(d.option_type, undefined);
    assert.equal(d.qty, 13);
  });

  it('does not clamp a LEAPS draft into 2–14 DTE', () => {
    const d = convertEquityDraftToCall({
      side: 'buy',
      asset_class: 'option',
      option_type: 'call',
      expiration: '2027-03-19',
      qty: 1,
      _play: { dte: 182, key: 'leaps-call', name: 'MU LEAPS core' },
    } as CallsOnlyHint);
    assert.equal(d.expiration, '2027-03-19');
    assert.equal(d._play?.dte, 182);
    assert.equal(d.option_type, 'call');
  });

  it('does not rewrite a put', () => {
    const d = convertEquityDraftToCall({
      asset_class: 'option', option_type: 'put' as const, qty: 1,
    });
    assert.equal(d.option_type, 'put');
  });
});

describe('shouldConvertEquityBot', () => {
  it('never converts leftover equity — autofix deletes instead', () => {
    assert.equal(shouldConvertEquityBot({
      classSkip: `'equity' not in allowlist [option]`,
      optionAllowed: true,
      mode: 'full_auto',
      env: 'alpaca_paper',
    }), false);
    assert.equal(shouldConvertEquityBot({
      classSkip: `'equity' not in allowlist [option]`,
      optionAllowed: true,
      mode: 'auto',
      env: 'alpaca_paper',
    }), false);
    assert.equal(isFullAutoPaper({ mode: 'full_auto', env: 'alpaca_paper' }), true);
  });
});

describe('STRATEGY_LIBRARY — prefer call, keep puts in the catalog', () => {
  it('swing / day factory defaults are call options', () => {
    const rsi = STRATEGY_LIBRARY.find((s) => s.key === 'rsi-bounce');
    assert.equal(rsi?.asset_class, 'option');
    assert.equal(rsi?.action.option_type, 'call');
    const orb = STRATEGY_LIBRARY.find((s) => s.key === 'opening-breakout');
    assert.equal(orb?.action.option_type, 'call');
    assert.equal(shouldSeedStrategy(rsi!), true);
    assert.equal(shouldSeedStrategy(orb!), false);
    assert.equal(shouldSeedStrategy(STRATEGY_LIBRARY.find((s) => s.key === 'donchian-breakout')!), false);
    assert.equal(shouldSeedStrategy(STRATEGY_LIBRARY.find((s) => s.key === 'ai-conviction-swing')!), false);
  });

  it('library LEAPS template is a far-dated long call, not a 14 DTE monthly', () => {
    const leaps = STRATEGY_LIBRARY.find((s) => s.key === 'leaps-call');
    assert.equal(leaps?.action.option_type, 'call');
    assert.equal(leaps?.action.expiration, 'leaps');
    assert.match(String(leaps?.name), /LEAPS/i);
  });

  it('does not delete put strategies — they stay in the library', () => {
    const puts = STRATEGY_LIBRARY.filter((s) => s.action.option_type === 'put');
    assert.ok(puts.length >= 3);
    assert.ok(puts.every((s) => s.category === 'options-puts'));
  });
});
