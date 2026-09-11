import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { decidePaperArm, PAPER_ARM_MIN_TRADES, MAC_DESK } from './paperArmDecide.js';

const winner = {
  bot_id: 4,
  name: 'Donchian Breakout',
  num_trades: 24,
  total_return_pct: 18.4,
  win_rate: 54,
  account_multiple: 1.4,
};

describe('decidePaperArm', () => {
  it('arms a profitable backtest with enough trades', () => {
    const d = decidePaperArm(winner, false);
    assert.equal(d.action, 'trade');
    assert.match(d.reason, /18\.4%/);
  });

  it('keeps observe-only stubs on watch even if the scan looks great', () => {
    const d = decidePaperArm({ ...winner, name: 'Mean-Revert Watch' }, true);
    assert.equal(d.action, 'watch');
    assert.match(d.reason, /never orders/);
  });

  it('skips losers', () => {
    const d = decidePaperArm({ ...winner, total_return_pct: -3.2 }, false);
    assert.equal(d.action, 'skip');
    assert.match(d.reason, /non-positive/);
  });

  it('skips thin samples', () => {
    const d = decidePaperArm({ ...winner, num_trades: PAPER_ARM_MIN_TRADES - 1 }, false);
    assert.equal(d.action, 'skip');
    assert.match(d.reason, /only 7/);
  });

  it('skips modeled-only option results', () => {
    const d = decidePaperArm({ ...winner, modeled: true }, false);
    assert.equal(d.action, 'skip');
    assert.match(d.reason, /modeled-only/);
  });

  it('skips backtest errors', () => {
    const d = decidePaperArm({ bot_id: 9, name: 'Broken', error: 'no bars' }, false);
    assert.equal(d.action, 'skip');
    assert.match(d.reason, /no bars/);
  });
});

describe('MAC_DESK', () => {
  it('lives under the grokbot Sites root', () => {
    assert.equal(MAC_DESK.grokbotRoot, '/Users/eric/Sites/grokbot');
    assert.equal(MAC_DESK.repo, '/Users/eric/Sites/grokbot/rh-trader');
    assert.ok(MAC_DESK.mamp.startsWith('http://localhost:8888/grokbot/rh-trader'));
  });
});
