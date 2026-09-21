import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { botEvalTimeframe, resolveAlpacaTimeframe, signalTimeframe } from './timeframe.js';

describe('resolveAlpacaTimeframe', () => {
  it('defaults to 1Day when _timeframe is missing', () => {
    assert.equal(resolveAlpacaTimeframe(undefined), '1Day');
    assert.equal(resolveAlpacaTimeframe(null), '1Day');
    assert.equal(resolveAlpacaTimeframe(''), '1Day');
    assert.equal(botEvalTimeframe({}), '1Day');
    assert.equal(botEvalTimeframe(null), '1Day');
  });

  it('maps 15m / 15Min to Alpaca 15Min', () => {
    assert.equal(resolveAlpacaTimeframe('15m'), '15Min');
    assert.equal(resolveAlpacaTimeframe('15Min'), '15Min');
    assert.equal(resolveAlpacaTimeframe('15min'), '15Min');
    assert.equal(botEvalTimeframe({ _timeframe: '15Min' }), '15Min');
  });

  it('maps 5m → 5Min and 1h / 1Hour → 1Hour', () => {
    assert.equal(resolveAlpacaTimeframe('5m'), '5Min');
    assert.equal(resolveAlpacaTimeframe('5Min'), '5Min');
    assert.equal(resolveAlpacaTimeframe('1h'), '1Hour');
    assert.equal(resolveAlpacaTimeframe('1Hour'), '1Hour');
  });

  it('keeps daily aliases on 1Day', () => {
    assert.equal(resolveAlpacaTimeframe('1d'), '1Day');
    assert.equal(resolveAlpacaTimeframe('1Day'), '1Day');
  });

  it('uses the same string on the signal row as the bars query', () => {
    assert.equal(signalTimeframe(resolveAlpacaTimeframe('15Min')), '15Min');
    assert.equal(signalTimeframe(resolveAlpacaTimeframe(undefined)), '1Day');
  });
});
