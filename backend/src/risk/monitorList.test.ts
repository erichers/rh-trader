import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  BOT_MATCH_BUY_SQL,
  MONITORS_LIST_SQL,
  closedMarketMonitorOpts,
} from './monitorList.js';

describe('monitors list query', () => {
  it('orders open stops first and keeps 200 rows', () => {
    assert.match(MONITORS_LIST_SQL, /ORDER BY \(status='open'\) DESC, opened_at DESC LIMIT 200/);
    assert.equal(MONITORS_LIST_SQL.includes('ORDER BY status ASC'), false);
    assert.equal(MONITORS_LIST_SQL.includes('LIMIT 100'), false);
  });
});

describe('bot match buy query', () => {
  it('selects filled and partially_filled buys only', () => {
    assert.match(BOT_MATCH_BUY_SQL, /o\.status IN \('filled','partially_filled'\)/);
    assert.equal(/status NOT IN/i.test(BOT_MATCH_BUY_SQL), false);
    assert.equal(BOT_MATCH_BUY_SQL.includes('vetoed'), false);
  });
});

describe('off-hours monitor pass', () => {
  it('still evaluates exits when any monitor is open', () => {
    assert.deepEqual(closedMarketMonitorOpts(1), { reconcileOnly: false });
    assert.deepEqual(closedMarketMonitorOpts(4), { reconcileOnly: false });
  });

  it('reconciles only when the book has no open monitor', () => {
    assert.deepEqual(closedMarketMonitorOpts(0), { reconcileOnly: true });
    assert.deepEqual(closedMarketMonitorOpts(Number.NaN), { reconcileOnly: true });
  });
});
