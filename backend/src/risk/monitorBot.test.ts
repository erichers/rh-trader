import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { matchMonitorBot, occFromOrderRaw, planMonitorOpen } from './monitorBot.js';

describe('monitor bot_id persistence', () => {
  it('persists the fill bot_id even when an open monitor was attached with null', () => {
    const plan = planMonitorOpen({
      draftBotId: 39,
      orderId: 8801,
      hasExisting: true,
      existingBotId: null,
    });
    assert.equal(plan.action, 'stamp');
    assert.equal(plan.bot_id, 39);
    assert.equal(plan.order_id, 8801);
  });

  it('inserts bot_id from the bot fill when no monitor is open yet', () => {
    const plan = planMonitorOpen({
      draftBotId: 88,
      orderId: 12,
      hasExisting: false,
    });
    assert.equal(plan.action, 'insert');
    assert.equal(plan.bot_id, 88);
    assert.equal(plan.order_id, 12);
  });

  it('does not overwrite a monitor that already has a bot', () => {
    const plan = planMonitorOpen({
      draftBotId: 39,
      orderId: 1,
      hasExisting: true,
      existingBotId: 88,
    });
    assert.equal(plan.action, 'skip');
    assert.equal(plan.bot_id, 88);
  });

  it('matches a unique buy order and refuses two different bots', () => {
    const occ = 'NVDA260116C00180000';
    const one = matchMonitorBot({
      symbol: 'NVDA',
      occ,
      orders: [
        { id: 10, bot_id: 39, symbol: 'NVDA', occ, side: 'buy' },
        { id: 9, bot_id: 39, symbol: 'NVDA', occ, side: 'buy' },
        { id: 8, bot_id: 4, symbol: 'SPY', occ: 'SPY260116C00500000', side: 'buy' },
      ],
    });
    assert.equal(one.via, 'order');
    assert.equal(one.bot_id, 39);
    assert.equal(one.order_id, 10);

    const mixed = matchMonitorBot({
      symbol: 'NVDA',
      occ,
      orders: [
        { id: 10, bot_id: 39, symbol: 'NVDA', occ, side: 'buy' },
        { id: 11, bot_id: 88, symbol: 'NVDA', occ, side: 'buy' },
      ],
    });
    assert.equal(mixed.via, 'ambiguous');
    assert.equal(mixed.bot_id, null);
  });

  it('falls back to a unique fired signal and ignores unfired rows', () => {
    const hit = matchMonitorBot({
      symbol: 'nvda',
      signals: [
        { bot_id: 88, symbol: 'NVDA', fired: 1 },
        { bot_id: 3, symbol: 'NVDA', fired: 0 },
        { bot_id: 3, symbol: 'QQQ', fired: 1 },
      ],
    });
    assert.equal(hit.via, 'signal');
    assert.equal(hit.bot_id, 88);
    assert.equal(hit.order_id, null);
  });

  it('reads OCC from order raw and ignores a bare underlying', () => {
    assert.equal(occFromOrderRaw({ draft: { _contract: { occSymbol: 'NVDA260116C00180000' } } }), 'NVDA260116C00180000');
    assert.equal(occFromOrderRaw({ place: { symbol: 'NVDA' } }), '');
  });
});
