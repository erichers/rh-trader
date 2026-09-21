import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyBotForAutofix,
  clampExitBand,
  proposeBotAutofix,
  resetAutofixForTests,
  runBotsAutofix,
} from './autofix.js';

describe('proposeBotAutofix', () => {
  it('put → observe, stays enabled, watch-only', () => {
    const p = proposeBotAutofix({
      id: 11,
      name: 'Long Put — Breakdown',
      enabled: 1,
      mode: 'full_auto',
      asset_class: 'option',
      action: { side: 'buy', option_type: 'put', expiration: 'weekly' },
      risk: { stop_loss_pct: 12, take_profit_pct: 30, trailing_stop_pct: 20 },
    });
    assert.ok(p);
    assert.equal(classifyBotForAutofix({
      name: 'Long Put — Breakdown', action: { option_type: 'put' },
    }), 'put');
    assert.equal(p!.next.mode, 'observe');
    assert.equal(p!.next.action._observe_only, true);
    assert.equal(p!.next.action.option_type, 'put');
    assert.match(p!.reason, /put/);
  });

  it('equity (no option_type) → observe', () => {
    const p = proposeBotAutofix({
      id: 12,
      name: 'Donchian Breakout',
      mode: 'full_auto',
      asset_class: 'equity',
      action: { side: 'buy', qty: 10 },
      risk: {},
    });
    assert.ok(p);
    assert.equal(classifyBotForAutofix({
      name: 'Donchian Breakout', action: { side: 'buy' }, asset_class: 'equity',
    }), 'equity');
    assert.equal(p!.next.mode, 'observe');
    assert.equal(p!.next.action._observe_only, true);
  });

  it('clamps sl>10, sets tp 20, trail default 10', () => {
    const p = proposeBotAutofix({
      id: 13,
      name: 'QQQ weekly call',
      mode: 'full_auto',
      asset_class: 'option',
      action: { side: 'buy', option_type: 'call', expiration: 'weekly' },
      risk: { stop_loss_pct: 18, take_profit_pct: 40, trailing_stop_pct: 25 },
    });
    assert.ok(p);
    assert.equal(p!.next.risk.stop_loss_pct, 10);
    assert.equal(p!.next.risk.take_profit_pct, 20);
    assert.equal(p!.next.risk.trailing_stop_pct, 10);
    assert.equal(p!.next.risk.hold_overnight, true);
    assert.equal(p!.next.risk.hold_over_weekend, true);
  });

  it('keeps a tighter sl and an in-range trail', () => {
    const band = clampExitBand({ stop_loss_pct: 6, take_profit_pct: 40, trailing_stop_pct: 12 });
    assert.equal(band.stop_loss_pct, 6);
    assert.equal(band.take_profit_pct, 20);
    assert.equal(band.trailing_stop_pct, 12);
  });

  it('LEAPS stay full_auto, keep far expiration, become call buy', () => {
    const p = proposeBotAutofix({
      id: 14,
      name: 'TSLA LEAPS',
      mode: 'observe',
      asset_class: 'equity',
      action: { side: 'buy', expiration: '2029-01-19' },
      risk: { stop_loss_pct: 8, take_profit_pct: 20, trailing_stop_pct: 10 },
    });
    assert.ok(p);
    assert.equal(classifyBotForAutofix({
      name: 'TSLA LEAPS', action: { expiration: '2029-01-19' },
    }), 'leaps');
    assert.equal(p!.next.mode, 'full_auto');
    assert.equal(p!.next.asset_class, 'option');
    assert.equal(p!.next.action.option_type, 'call');
    assert.equal(p!.next.action.side, 'buy');
    assert.equal(p!.next.action.expiration, '2029-01-19');
    assert.equal(p!.next.action._observe_only, undefined);
    assert.equal(p!.next.risk.hold_overnight, true);
    assert.equal(p!.next.risk.hold_over_weekend, true);
  });

  it('already-compliant LEAPS is skipped (idempotent)', () => {
    const bot = {
      id: 15,
      name: 'AAPL LEAPS momo',
      mode: 'full_auto',
      asset_class: 'option',
      action: { side: 'buy', option_type: 'call', expiration: 'leaps' },
      risk: { stop_loss_pct: 10, take_profit_pct: 20, trailing_stop_pct: 10, hold_overnight: true, hold_over_weekend: true },
    };
    assert.equal(proposeBotAutofix(bot), null);
    assert.equal(proposeBotAutofix({ ...bot, ...proposeBotAutofix({
      ...bot, mode: 'cautious',
    })?.next, id: 15, name: bot.name }), null);
  });

  it('covered-call sell → observe', () => {
    const p = proposeBotAutofix({
      id: 16,
      name: 'Covered-call income',
      mode: 'auto',
      asset_class: 'option',
      action: { side: 'sell', option_type: 'call', covered: true, expiration: 'monthly' },
      risk: {},
    });
    assert.ok(p);
    assert.equal(p!.next.mode, 'observe');
    assert.match(p!.reason, /sell|covered/i);
  });

  it('observe stub is not promoted to full_auto', () => {
    const p = proposeBotAutofix({
      id: 17,
      name: 'Mean-Revert Watch',
      mode: 'full_auto',
      enabled: 1,
      action: { side: 'buy', option_type: 'call', _observe_only: true, _strategy: 'mean-revert-watch' },
      risk: { _observe_only: true, stop_loss_pct: 10, take_profit_pct: 20, trailing_stop_pct: 10, hold_overnight: true, hold_over_weekend: true },
    });
    assert.ok(p);
    assert.equal(p!.next.mode, 'observe');
    assert.notEqual(p!.next.mode, 'full_auto');
  });

  it('rewrites QuickBot play risk the same way', () => {
    const p = proposeBotAutofix({
      id: 18,
      name: 'QuickBot basket',
      mode: 'full_auto',
      asset_class: 'option',
      action: {
        side: 'buy',
        option_type: 'call',
        _quickbot: true,
        plays: [{ key: 'momo_up', name: 'Up-momentum', dte: 7, risk: { sl: 18, tp: 40, trail: 25 } }],
      },
      risk: { stop_loss_pct: 10, take_profit_pct: 20, trailing_stop_pct: 10, dte_bands: { 7: { sl: 15, tp: 40, trail: 20 } } },
    });
    assert.ok(p);
    assert.equal(p!.next.action.plays[0].risk.sl, 10);
    assert.equal(p!.next.action.plays[0].risk.tp, 20);
    assert.equal(p!.next.risk.dte_bands[7].sl, 10);
    assert.equal(p!.next.risk.dte_bands[7].tp, 20);
  });
});

describe('runBotsAutofix', () => {
  it('applies puts/equity and skips compliant LEAPS', async () => {
    resetAutofixForTests();
    const saved: any[] = [];
    const logs: string[] = [];
    const bots = [
      { id: 1, name: 'Long Put — Hedge', mode: 'full_auto', asset_class: 'option', enabled: 1, action: { option_type: 'put', side: 'buy' }, risk: {} },
      { id: 2, name: 'RSI Bounce', mode: 'auto', asset_class: 'equity', enabled: 1, action: { side: 'buy' }, risk: {} },
      { id: 3, name: 'NVDA LEAPS', mode: 'full_auto', asset_class: 'option', enabled: 1, action: { side: 'buy', option_type: 'call', expiration: 'leaps' }, risk: { stop_loss_pct: 10, take_profit_pct: 20, trailing_stop_pct: 10, hold_overnight: true, hold_over_weekend: true } },
    ];
    const out = await runBotsAutofix({
      env: 'alpaca_paper',
      loadBots: async () => bots,
      saveBot: async (row) => { saved.push(row); },
      log: async (type, msg) => { logs.push(`${type}:${msg}`); },
      now: () => '2026-09-21T16:30:00.000Z',
    });
    assert.equal(out.ok, true);
    assert.equal(out.fixed.length, 2);
    assert.equal(out.skipped.length, 1);
    assert.equal(out.skipped[0].name, 'NVDA LEAPS');
    assert.equal(saved.length, 2);
    assert.ok(logs.some((l) => l.startsWith('bot.autofix:')));
    assert.match(out.summary, /fixed 2/);
  });
});
