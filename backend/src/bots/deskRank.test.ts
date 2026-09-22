import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { actionAfterRank, rankDeskBot, riskAfterRank } from './deskRank.js';
import { refuseRankEnv } from './deskRankApply.js';

const closes = (n: number, pnl: number, reason = 'stop-loss') =>
  Array.from({ length: n }, () => ({ pnl_pct: pnl, reason }));

describe('desk rank', () => {
  it('refuses anything but Alpaca paper', () => {
    assert.equal(refuseRankEnv('alpaca_paper'), null);
    assert.match(refuseRankEnv('robinhood_live') || '', /paper/);
  });

  it('demotes a chronic loser and does not touch Jev exit', () => {
    const d = rankDeskBot(
      { id: 3, name: 'RSI Bounce', mode: 'full_auto', enabled: 1, action: { option_type: 'call' }, risk: { stop_loss_pct: 10, jev: { entry: false, exit: false } } },
      closes(6, -12, 'stop-loss'),
    );
    assert.equal(d.action, 'demote');
    assert.equal(d.mode, 'observe');
    assert.equal(d.enabled, 0);
    assert.equal(d.touchJevExit, false);
    const risk = riskAfterRank({ stop_loss_pct: 10, jev: { entry: false, exit: false } }, d);
    assert.equal(risk?.stop_loss_pct, 10);
    assert.equal(risk?.jev.exit, false);
    assert.equal(actionAfterRank({ option_type: 'call' }, d)?._full_auto_ok, false);
  });

  it('tightens size on a stop-heavy bot and leaves the hard stop', () => {
    const d = rankDeskBot(
      { id: 4, name: 'Donchian Breakout', mode: 'full_auto', action: { option_type: 'call' }, risk: { max_position_usd: 2000, stop_loss_pct: 10 } },
      [
        ...closes(3, 4, 'stop-loss'),
        ...closes(2, 6, 'trail'),
      ],
    );
    assert.equal(d.action, 'tighten');
    assert.equal(d.maxPositionUsd, 1200);
    assert.match(d.reason, /Hard stop stays -10%/);
    const risk = riskAfterRank({ max_position_usd: 2000, stop_loss_pct: 10, jev: { exit: false } }, d);
    assert.equal(risk?.max_position_usd, 1200);
    assert.equal(risk?.stop_loss_pct, 10);
    assert.equal(risk?.jev.exit, false);
    const again = rankDeskBot(
      { id: 4, name: 'Donchian Breakout', action: { option_type: 'call' }, risk },
      [...closes(3, 4, 'stop-loss'), ...closes(2, 6, 'trail')],
    );
    assert.equal(again.action, 'hold');
  });

  it('promotes a winner without turning Jev exit on', () => {
    const d = rankDeskBot(
      { id: 5, name: 'Long Call — Momentum', mode: 'cautious', enabled: 0, action: { option_type: 'call', _liquidity: 'listed' }, risk: { jev: { entry: false, exit: false } } },
      closes(6, 8, 'gain-lock'),
      { num_trades: 12, total_return_pct: 15, modeled: false },
    );
    assert.equal(d.action, 'promote');
    assert.equal(d.mode, 'full_auto');
    assert.equal(d.touchJevExit, false);
    assert.match(d.reason, /Jev exit stays off/);
    const risk = riskAfterRank({ jev: { entry: false, exit: false } }, d);
    assert.equal(risk?.jev.exit, false);
    assert.equal(risk?._full_auto_ok, true);
  });

  it('does not full-auto an unverified winner or a put', () => {
    const thin = rankDeskBot(
      { id: 6, name: 'AI Datacenter Call Pack', action: { option_type: 'call', _liquidity: 'unverified', _quickbot: true }, risk: {} },
      closes(6, 9, 'trail'),
      { num_trades: 10, total_return_pct: 20 },
    );
    assert.equal(thin.action, 'hold');
    assert.match(thin.reason, /unverified/);
    const put = rankDeskBot(
      { id: 7, name: 'Long Put — Breakdown', action: { option_type: 'put' }, risk: {} },
      closes(6, 9, 'trail'),
      { num_trades: 10, total_return_pct: 20 },
    );
    assert.equal(put.action, 'hold');
    assert.match(put.reason, /puts/);
  });

  it('holds a watch stub and a short sample', () => {
    const watch = rankDeskBot(
      { id: 8, name: 'AI Boom Watch', observeOnly: true, action: { _observe_only: true }, risk: {} },
      closes(8, -20, 'stop-loss'),
    );
    assert.equal(watch.action, 'hold');
    const thin = rankDeskBot(
      { id: 9, name: 'AVGO Broadcom Call', action: { option_type: 'call' }, risk: {} },
      closes(2, -5, 'stop-loss'),
    );
    assert.equal(thin.action, 'hold');
    assert.match(thin.reason, /Need 5/);
  });
});
