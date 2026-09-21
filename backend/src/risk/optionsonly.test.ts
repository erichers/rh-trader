import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { config } from '../config.js';
import {
  DELETED_EQUITY_BOT_KEYS,
  DELETED_EQUITY_BOT_NAMES,
  EQUITY_REFUSED_REASON,
  isDeletedLeftoverEquity,
  isEquityAssetClass,
  optionOnlyAllowlist,
  refuseEquityBot,
  refuseEquityBuy,
} from './optionsonly.js';

describe('options-only law', () => {
  it('config allowlist is option even if env listed equity', () => {
    assert.deepEqual(optionOnlyAllowlist('equity,etf,option'), ['option']);
    assert.deepEqual(optionOnlyAllowlist('option'), ['option']);
    assert.deepEqual(optionOnlyAllowlist(''), ['option']);
    assert.deepEqual(optionOnlyAllowlist(['equity', 'option']), ['option']);
    assert.ok(config.trading.allowedAssetClasses.includes('option'));
    assert.ok(!config.trading.allowedAssetClasses.includes('equity'));
    assert.ok(!config.trading.allowedAssetClasses.includes('etf'));
  });

  it('refuses equity / etf bots and the 10 Mac-deleted leftover names', () => {
    assert.equal(isEquityAssetClass('equity'), true);
    assert.equal(isEquityAssetClass('etf'), true);
    assert.equal(isEquityAssetClass('option'), false);
    assert.equal(refuseEquityBot({ asset_class: 'equity', name: 'RSI Bounce' }), EQUITY_REFUSED_REASON);
    assert.equal(refuseEquityBot({ asset_class: 'option', name: 'Long Call — Momentum' }), null);
    assert.equal(refuseEquityBot({ asset_class: 'option', name: 'Donchian Breakout', key: 'donchian-breakout' }), EQUITY_REFUSED_REASON);
    assert.ok(isDeletedLeftoverEquity({ name: 'Equity Snapback' }));
    assert.ok(DELETED_EQUITY_BOT_NAMES.length >= 10);
    assert.ok(DELETED_EQUITY_BOT_KEYS.includes('opening-breakout'));
  });

  it('refuses equity buys and allows leftover share sells to flatten', () => {
    assert.equal(refuseEquityBuy({ asset_class: 'equity', side: 'buy' }), EQUITY_REFUSED_REASON);
    assert.equal(refuseEquityBuy({ asset_class: 'equity', side: 'sell' }), null);
    assert.equal(refuseEquityBuy({ asset_class: 'option', side: 'buy' }), null);
  });
});
