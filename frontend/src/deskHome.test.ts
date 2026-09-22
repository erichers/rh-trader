import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { blockedBotCount } from './botIssues.ts';
import { hotConcentration, maxLossPct, openRiskPreview } from './deskHome.ts';

const law = { hardStopPct: 10, gainLockArmPct: 10, gainLockFloorPct: 1.5 };

describe('home glance', () => {
  it('counts a blocked bot and ignores a bot that can fire', () => {
    const health = { broker: { alpacaConfigured: true }, env: 'alpaca_paper' };
    const n = blockedBotCount([
      { enabled: true, asset_class: 'option', rules: { rsi_below: 30 }, action: {} },
      { enabled: true, asset_class: 'equity', rules: { rsi_below: 30 }, action: {} },
      { enabled: false, asset_class: 'option', rules: { rsi_below: 30 }, action: {}, last_result: [{ error: 'no' }] },
    ], health);
    assert.equal(n, 1);
  });

  it('reads max daily loss from the desk limits', () => {
    assert.equal(maxLossPct({ limits: { maxDailyLossPct: 4 }, riskLaw: { maxDailyDrawdownPct: 9 } }), 4);
    assert.equal(maxLossPct({ riskLaw: { maxDailyDrawdownPct: 9 } }), 9);
    assert.equal(maxLossPct({}), null);
  });

  it('flags concentration only when a name is at the cap', () => {
    const rows = [
      { symbol: 'NVDA', market_value: 30 },
      { symbol: 'SPY260930C00500000', asset_class: 'option', market_value: 10 },
    ];
    assert.equal(hotConcentration(rows, 100, 25)?.symbol, 'NVDA');
    assert.equal(hotConcentration(rows, 100, 40), null);
  });

  it('sorts a stuck sell ahead of a green open', () => {
    const preview = openRiskPreview(
      [
        { id: 1, symbol: 'QQQ', asset_class: 'equity', avg_cost: 100, last_price: 104 },
        { id: 2, symbol: 'SPY', occ_symbol: 'SPY260930C00500000', asset_class: 'option', avg_cost: 2, last_price: 1 },
      ],
      [
        { status: 'open', symbol: 'SPY', occ_symbol: 'SPY260930C00500000', entry_price: 2, last_price: 1, pending_exit_order_id: 4 },
        { status: 'open', symbol: 'QQQ', entry_price: 100, last_price: 104 },
      ],
      law,
    );
    assert.equal(preview.rows[0].symbol, 'SPY');
    assert.equal(preview.rows[0].pulseLabel, 'Stuck sell');
    assert.equal(preview.rows[0].pulseTone, 'red');
    assert.equal(preview.rows[1].pulseLabel, 'Holding');
  });

  it('does not invent a calm pulse before the exit watch loads', () => {
    const preview = openRiskPreview(
      [{ id: 1, symbol: 'SPY', avg_cost: 100, last_price: 101 }],
      null,
      law,
    );
    assert.equal(preview.rows[0].pulseLabel, 'Exits unknown');
  });
});
