import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  isObserveOnlyBot,
  observeOnlyGate,
  observeOnlySkipWhy,
  execObserveBlock,
  OBSERVE_STUB_NAMES,
  OBSERVE_STUB_KEYS,
} from './observe.js';

describe('isObserveOnlyBot', () => {
  it('detects _observe_only on action even when enabled and mode=auto', () => {
    assert.equal(isObserveOnlyBot({
      name: 'Mean-Revert Watch',
      enabled: 1,
      mode: 'auto',
      action: { side: 'buy', qty: 10, _observe_only: true, _strategy: 'mean-revert-watch' },
    }), true);
  });

  it('detects observe_only on rules / risk JSON strings', () => {
    assert.equal(isObserveOnlyBot({ rules: '{"_observe_only":true}' }), true);
    assert.equal(isObserveOnlyBot({ risk: '{"observe_only":true}' }), true);
  });

  it('detects known stub names without a flag (desk bots 19–21)', () => {
    for (const name of OBSERVE_STUB_NAMES) {
      assert.equal(isObserveOnlyBot({ name, mode: 'auto', enabled: 1, action: { side: 'buy' } }), true, name);
    }
  });

  it('detects known strategy keys', () => {
    for (const key of OBSERVE_STUB_KEYS) {
      assert.equal(isObserveOnlyBot({ name: 'Custom', action: { _strategy: key } }), true, key);
    }
  });

  it('does not treat a normal trading bot as observe-only', () => {
    assert.equal(isObserveOnlyBot({
      name: 'Donchian Breakout',
      mode: 'auto',
      enabled: 1,
      action: { side: 'buy', qty: 5, _strategy: 'donchian-breakout' },
    }), false);
  });

  it('mode=observe alone is not the stub flag', () => {
    assert.equal(isObserveOnlyBot({
      name: 'RSI Bounce',
      mode: 'observe',
      action: { side: 'buy', _strategy: 'rsi-bounce' },
    }), false);
  });
});

describe('observeOnlyGate', () => {
  it('blocks buys and forbids any order row (draft/stage/place/veto)', () => {
    const g = observeOnlyGate({ observeOnly: true, side: 'buy' });
    assert.equal(g.blocked, true);
    assert.equal(g.createOrderRow, false);
    assert.equal(g.status, 'observe_only');
    assert.match(g.reason, /no order created/);
  });

  it('still allows close-only sells so leftover paper can flatten', () => {
    const g = observeOnlyGate({ observeOnly: true, side: 'sell' });
    assert.equal(g.blocked, false);
    assert.equal(g.createOrderRow, true);
  });

  it('does not block ordinary bots', () => {
    const g = observeOnlyGate({ observeOnly: false, side: 'buy' });
    assert.equal(g.blocked, false);
    assert.equal(g.createOrderRow, true);
  });
});

describe('observeOnlySkipWhy', () => {
  it('appends the no-order note to a fired signal', () => {
    assert.match(observeOnlySkipWhy('Fired: RSI < 32.'), /no order created/);
  });
});

describe('execObserveBlock — order pipeline', () => {
  it('blocks a fired auto-mode stub so executeDraft must not insert a row', () => {
    const g = execObserveBlock(
      { side: 'buy', _observe_only: true },
      { name: 'Quiet Range Scout', mode: 'auto', action: { side: 'buy', qty: 8 } },
    );
    assert.equal(g.blocked, true);
    assert.equal(g.createOrderRow, false);
  });

  it('blocks by stub name even if the JSON flag was stripped', () => {
    const g = execObserveBlock(
      { side: 'buy' },
      { name: 'Vol-Regime MR', mode: 'full_auto', enabled: 1, action: { side: 'buy' } },
    );
    assert.equal(g.blocked, true);
    assert.equal(g.createOrderRow, false);
  });

  it('lets a real Donchian / Momentum / ORB ticket through the observe gate', () => {
    for (const name of ['Donchian Breakout', 'Momentum Day Trade', 'Opening Range Breakout']) {
      const g = execObserveBlock({ side: 'buy' }, { name, mode: 'auto', action: { side: 'buy', _strategy: 'donchian-breakout' } });
      assert.equal(g.blocked, false, name);
    }
  });
});
