import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { applyMuseImprove, proposeMuseImprove, resetMuseImproveForTests } from './improve.js';
import { museWatchLamp } from './watch.js';

describe('muse improve local path', () => {
  it('clamps sl>10, tp toward 20, trail into 8–15', () => {
    const p = proposeMuseImprove({
      id: 38,
      name: 'QQQ momo',
      mode: 'full_auto',
      enabled: 1,
      action: { option_type: 'call', side: 'buy' },
      risk: { stop_loss_pct: 18, take_profit_pct: 40, trailing_stop_pct: 25 },
      rules: {},
    });
    assert.ok(p);
    assert.equal(p!.next.risk.stop_loss_pct, 10);
    assert.equal(p!.next.risk.take_profit_pct, 20);
    assert.equal(p!.next.risk.trailing_stop_pct, 10);
    assert.ok(p!.changes.some((c) => c.field === 'stop_loss_pct'));
  });

  it('bumps min_matches when last_result is noisy skips', () => {
    const p = proposeMuseImprove({
      id: 39,
      name: 'NVDA call',
      mode: 'full_auto',
      action: { option_type: 'call' },
      risk: { stop_loss_pct: 10, take_profit_pct: 20, trailing_stop_pct: 10 },
      rules: { min_matches: 1 },
      last_result: [
        { symbol: 'NVDA', skipped: 'no fresh cross' },
        { symbol: 'NVDA', skipped: 'stale' },
        { symbol: 'NVDA', skipped: 'already >' },
      ],
    });
    assert.ok(p);
    assert.equal(p!.next.rules.min_matches, 2);
  });

  it('no-op when already clamped', () => {
    assert.equal(proposeMuseImprove({
      name: 'AAPL LEAPS',
      action: { option_type: 'call', expiration: 'leaps' },
      risk: { stop_loss_pct: 8, take_profit_pct: 20, trailing_stop_pct: 12 },
      rules: { min_matches: 2 },
    }), null);
  });

  it('never proposes on observe stubs', () => {
    assert.equal(proposeMuseImprove({
      name: 'Mean-Revert Watch',
      action: { _observe_only: true, _strategy: 'mean-revert-watch' },
      risk: { stop_loss_pct: 18 },
    }), null);
  });

  it('apply writes muse.improve audits and skips live env', async () => {
    resetMuseImproveForTests();
    const logs: string[] = [];
    const saved: any[] = [];
    const bots = [{
      id: 38, name: 'Tune me', mode: 'full_auto',
      action: { option_type: 'call' },
      risk: { stop_loss_pct: 16, take_profit_pct: 40, trailing_stop_pct: 4 },
      rules: {},
    }];
    const live = await applyMuseImprove(bots, { env: 'robinhood_live', save: async (p) => { saved.push(p); } });
    assert.equal(live.applied.length, 0);

    const paper = await applyMuseImprove(bots, {
      env: 'alpaca_paper',
      save: async (p) => { saved.push(p); },
      log: async (type, msg) => { logs.push(`${type}:${msg}`); },
    });
    assert.equal(paper.applied.length, 1);
    assert.equal(saved.length, 1);
    assert.ok(logs.some((l) => l.startsWith('muse.improve:')));
  });
});

describe('museWatchLamp improve vs observe', () => {
  it('improve + unconfigured is local, not n/a forever', () => {
    const lamp = museWatchLamp({
      configured: false,
      running: false,
      lastCycle: '2026-09-21T16:00:00.000Z',
      lastError: null,
      mode: 'improve',
      via: 'local',
      lastTune: { at: '2026-09-21T16:00:00.000Z', botId: 38, name: '#38' },
    });
    assert.equal(lamp.available, true);
    assert.equal(lamp.ok, true);
    assert.equal(lamp.observeOnly, false);
    assert.equal(lamp.via, 'local');
    assert.equal(lamp.mode, 'improve');
    assert.match(lamp.note, /improve|local/i);
  });

  it('observe + unconfigured stays unknown, not green', () => {
    const lamp = museWatchLamp({
      configured: false, running: true, lastCycle: 'x', lastError: null, mode: 'observe',
    });
    assert.equal(lamp.ok, false);
    assert.equal(lamp.available, false);
    assert.equal(lamp.observeOnly, true);
  });
});
