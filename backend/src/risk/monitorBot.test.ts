import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { matchMonitorBot, occFromOrderRaw, planMonitorOpen, type MonitorOrderCandidate } from './monitorBot.js';

function filled(row: MonitorOrderCandidate): MonitorOrderCandidate {
  return { status: 'filled', side: 'buy', ...row };
}

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
        filled({ id: 10, bot_id: 39, symbol: 'NVDA', occ }),
        filled({ id: 11, bot_id: 88, symbol: 'NVDA', occ }),
        filled({ id: 12, bot_id: 4, symbol: 'NVDA', occ: 'NVDA260116C00190000' }),
      ],
    });
    assert.equal(latest.via, 'order');
    assert.equal(latest.bot_id, 88);
    assert.equal(latest.order_id, 11);

    const bare = matchMonitorBot({
      symbol: 'NVDA',
      occ,
      orders: [
        filled({ id: 3, bot_id: 39, symbol: 'NVDA' }),
        filled({ id: 7, bot_id: 88, symbol: 'NVDA', occ: '' }),
      ],
    });
    assert.equal(bare.bot_id, 88);
    assert.equal(bare.order_id, 7);

    const wrongContract = matchMonitorBot({
      symbol: 'NVDA',
      occ,
      orders: [filled({ id: 9, bot_id: 4, symbol: 'NVDA', occ: 'NVDA260116C00190000' })],
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

  it('ignores vetoed, canceled, and rejected buys and does not stamp Index onto NVDA', () => {
    const occ = 'NVDA260116C00180000';
    const index = 'Index QuickBot — SPY & QQQ';
    const vetoed = matchMonitorBot({
      symbol: 'NVDA',
      occ,
      draftBotId: 39,
      draftStatus: 'vetoed',
      draftBotName: index,
      orders: [
        { id: 304, bot_id: 39, symbol: 'NVDA', occ, side: 'buy', status: 'vetoed', bot_name: index },
        { id: 305, bot_id: 39, symbol: 'NVDA', occ, side: 'buy', status: 'canceled', bot_name: index },
        { id: 306, bot_id: 39, symbol: 'NVDA', occ, side: 'buy', status: 'rejected', bot_name: index },
        { id: 307, bot_id: 39, symbol: 'NVDA', occ, side: 'buy', status: 'draft', bot_name: index },
      ],
      signals: [{ bot_id: 39, symbol: 'NVDA', fired: 1, bot_name: index }],
    });
    assert.equal(vetoed.via, 'none');
    assert.equal(vetoed.bot_id, null);
    assert.equal(vetoed.order_id, null);

    const realFill = matchMonitorBot({
      symbol: 'NVDA',
      occ,
      orders: [
        { id: 400, bot_id: 39, symbol: 'NVDA', occ, side: 'buy', status: 'vetoed', bot_name: index },
        filled({ id: 210, bot_id: 88, symbol: 'NVDA', occ, bot_name: 'NVDA Momentum' }),
      ],
    });
    assert.equal(realFill.via, 'order');
    assert.equal(realFill.bot_id, 88);
    assert.equal(realFill.order_id, 210);

    const indexFillOnNvda = matchMonitorBot({
      symbol: 'NVDA',
      occ,
      orders: [filled({ id: 60, bot_id: 39, symbol: 'NVDA', occ, bot_name: index })],
    });
    assert.equal(indexFillOnNvda.bot_id, null);
    assert.equal(indexFillOnNvda.via, 'none');

    const indexPartial = matchMonitorBot({
      symbol: 'QQQ',
      occ: 'QQQ260116C00500000',
      orders: [{
        id: 70, bot_id: 39, symbol: 'QQQ', occ: 'QQQ260116C00500000', side: 'buy',
        status: 'partially_filled', bot_name: index,
      }],
    });
    assert.equal(indexPartial.bot_id, 39);
    assert.equal(indexPartial.order_id, 70);
  });
});
