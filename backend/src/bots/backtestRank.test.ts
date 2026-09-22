import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { FOX_BACKTEST_RANK_SHAPE, FOX_RANK_PREFERRED_BOTS, foxBacktestRank, mapBacktestRankRow } from './backtestRank.js';

describe('fox backtest rank', () => {
  it('maps symbol × strategy × DTE onto the score fields Fox reads', () => {
    const row = mapBacktestRankRow({
      symbol: 'spy',
      key: 'momo_up',
      label: 'Up momentum',
      dte: 7,
      robust: true,
      metrics: {
        expectancy_pct: 1.25,
        num_trades: 14,
        win_rate: 57,
        max_drawdown_pct: -6.2,
        total_return_pct: 18,
        profit_factor: 1.6,
        best_multiple: 2.4,
      },
    });
    assert.equal(row.kind, 'play');
    assert.equal(row.symbol, 'SPY');
    assert.equal(row.strategy, 'momo_up');
    assert.equal(row.dte, 7);
    assert.equal(row.expectancy_pct, 1.25);
    assert.equal(row.trades, 14);
    assert.equal(row.win_rate, 57);
    assert.equal(row.max_drawdown_pct, -6.2);
    assert.equal(row.robust, true);
    assert.equal(row.preferred, false);
  });

  it('puts paper fill bots 86, 39, 88 first', () => {
    const rank = foxBacktestRank([
      { bot_id: 12, name: 'Other', symbol: 'AAPL', num_trades: 20, total_return_pct: 40, metrics: { expectancy_pct: 9, num_trades: 20 } },
      { bot_id: 88, name: 'G8 trail', symbol: 'QQQ', num_trades: 9, metrics: { expectancy_pct: 1, num_trades: 9, max_drawdown_pct: -4 } },
      { bot_id: 39, name: 'Index QuickBot', symbol: 'SPY', num_trades: 11, metrics: { expectancy_pct: 2, num_trades: 11 } },
      { bot_id: 86, name: 'G4 NVDA', symbol: 'NVDA', num_trades: 8, metrics: { expectancy_pct: 0.4, num_trades: 8 } },
      { symbol: 'MSFT', key: 'breakout_up', dte: 7, robust: true, metrics: { expectancy_pct: 5, num_trades: 30, win_rate: 60 } },
    ]);
    assert.equal(rank.shape, FOX_BACKTEST_RANK_SHAPE);
    assert.deepEqual(rank.preferred_bot_ids, [...FOX_RANK_PREFERRED_BOTS]);
    assert.deepEqual(rank.rank.map((r) => r.bot_id), [86, 39, 88, null, 12]);
    assert.equal(rank.rank[0].preferred, true);
    assert.equal(rank.rank[0].symbol, 'NVDA');
    assert.equal(rank.rank[3].strategy, 'breakout_up');
    assert.equal(rank.rank[3].dte, 7);
    assert.match(rank.preferred_note, /86/);
  });
});
