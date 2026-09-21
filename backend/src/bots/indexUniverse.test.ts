import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { clampIndexQuickbotUniverse, evalSymbols } from './indexUniverse.js';
import { classifyBotForAutofix, proposeBotAutofix } from './autofix.js';

describe('Index QuickBot universe', () => {
  it('clamps drifted symbols back to SPY and QQQ and drops other plays', () => {
    const p = proposeBotAutofix({
      id: 12,
      name: 'Index QuickBot — SPY & QQQ',
      enabled: 1,
      mode: 'full_auto',
      asset_class: 'option',
      symbols: ['SPY', 'QQQ', 'NVDA'],
      action: {
        _quickbot: true,
        option_type: 'call',
        side: 'buy',
        symbol_plays: { SPY: [{ key: 'momo' }], NVDA: [{ key: 'momo' }] },
      },
      risk: {
        stop_loss_pct: 10,
        take_profit_pct: 20,
        trailing_stop_pct: 10,
        hold_overnight: true,
        hold_over_weekend: true,
      },
    });
    assert.equal(classifyBotForAutofix({
      name: 'Index QuickBot — SPY & QQQ',
      asset_class: 'option',
      action: { _quickbot: true },
    }), 'ok');
    assert.ok(p);
    assert.equal(p!.delete, undefined);
    assert.deepEqual(p!.next.symbols, ['SPY', 'QQQ']);
    assert.deepEqual(Object.keys(p!.next.action.symbol_plays), ['SPY']);
    assert.equal(p!.next.enabled, 1);
    assert.ok(p!.changes.some((c) => c.field === 'symbols'));
  });

  it('is a no-op when the basket is already SPY and QQQ', () => {
    assert.equal(clampIndexQuickbotUniverse({
      name: 'Index QuickBot — SPY & QQQ',
      symbols: ['QQQ', 'SPY'],
      action: { symbol_plays: { SPY: [], QQQ: [] } },
    }), null);
    assert.equal(clampIndexQuickbotUniverse({
      name: 'NVDA call',
      symbols: ['NVDA', 'AMD'],
    }), null);
  });

  it('focus does not move Index QuickBot onto another underlying', () => {
    const kept = evalSymbols(
      { name: 'Index QuickBot — SPY & QQQ', symbols: ['SPY', 'QQQ'] },
      { enabled: true, symbol: 'NVDA' },
    );
    assert.deepEqual(kept, ['SPY', 'QQQ']);
    const moved = evalSymbols(
      { name: 'NVDA Momentum', symbols: ['NVDA'] },
      { enabled: true, symbol: 'QQQ' },
    );
    assert.equal(moved, '["QQQ"]');
  });
});
