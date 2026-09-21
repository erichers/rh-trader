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

  it('leaves an AI open with null bot_id alone', () => {
    const plan = planMonitorOpen({
      draftBotId: null,
      orderId: 4,
      hasExisting: true,
      existingBotId: null,
    });
    assert.equal(plan.action, 'skip');
    assert.equal(plan.bot_id, null);
    const fresh = planMonitorOpen({ draftBotId: null, orderId: 4, hasExisting: false });
    assert.equal(fresh.action, 'insert');
    assert.equal(fresh.bot_id, null);
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

  it('uses the latest buy, preferring exact OCC over a different contract', () => {
    const occ = 'NVDA260116C00180000';
    const latest = matchMonitorBot({
      symbol: 'NVDA',
      occ,
      orders: [
        { id: 10, bot_id: 39, symbol: 'NVDA', occ, side: 'buy' },
        { id: 11, bot_id: 88, symbol: 'NVDA', occ, side: 'buy' },
        { id: 12, bot_id: 4, symbol: 'NVDA', occ: 'NVDA260116C00190000', side: 'buy' },
      ],
    });
    assert.equal(latest.via, 'order');
    assert.equal(latest.bot_id, 88);
    assert.equal(latest.order_id, 11);

    const bare = matchMonitorBot({
      symbol: 'NVDA',
      occ,
      orders: [
        { id: 3, bot_id: 39, symbol: 'NVDA', side: 'buy' },
        { id: 7, bot_id: 88, symbol: 'NVDA', occ: '', side: 'buy' },
      ],
    });
    assert.equal(bare.bot_id, 88);
    assert.equal(bare.order_id, 7);

    const wrongContract = matchMonitorBot({
      symbol: 'NVDA',
      occ,
      orders: [{ id: 9, bot_id: 4, symbol: 'NVDA', occ: 'NVDA260116C00190000', side: 'buy' }],
    });
    assert.equal(wrongContract.via, 'none');
    assert.equal(wrongContract.bot_id, null);
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
