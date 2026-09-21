import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { exitReason } from './exitpolicy.js';
import { jevEntryGate, resetJevLastForTests, type JevClient } from './jev.js';
import { jevExitGate } from './jevExit.js';
import { resetJevBudgetForTests } from './jevBudget.js';
import {
  JEV_CADENCE_LEAPS_MS,
  JEV_CADENCE_MEDIUM_MS,
  JEV_CADENCE_SHORT_MS,
  jevCadenceWindowMs,
  mergeJevExit,
  parseJevBotFlags,
  resetJevCadenceForTests,
  resolveMonitorExit,
  tightenTrail,
} from './jevScope.js';

function exitClient(choice: string, confidence = 0.91): JevClient {
  return {
    async systemOne() {
      return {
        model: 'jev-latest',
        answers: {
          thesis_intact: { type: 'noul', noul: 0.4 },
          action: { type: 'choice', choice, confidence, probabilities: { [choice]: 1 } },
          giveback_risk: { type: 'score', score: 1.2, confidence: 0.8 },
          time_pressure: { type: 'noul', noul: 0.2 },
        },
        usage: { input_tokens: 20, output_tokens: 4 },
      };
    },
  };
}

describe('per-bot Jev scope', () => {
  beforeEach(() => {
    resetJevBudgetForTests();
    resetJevLastForTests();
    resetJevCadenceForTests();
  });

  it('defaults entry and exit off', () => {
    assert.deepEqual(parseJevBotFlags(undefined), { entry: false, exit: false });
    assert.deepEqual(parseJevBotFlags(null), { entry: false, exit: false });
    assert.deepEqual(parseJevBotFlags({}), { entry: false, exit: false });
    assert.deepEqual(parseJevBotFlags({ stop_loss_pct: 10, take_profit_pct: 20 }), { entry: false, exit: false });
    assert.deepEqual(parseJevBotFlags({ jev: { entry: true } }), { entry: true, exit: false });
    assert.deepEqual(parseJevBotFlags('{"jev":{"exit":true}}'), { entry: false, exit: true });
    assert.deepEqual(parseJevBotFlags({ jev: { entry: 'false', exit: 0 } }), { entry: false, exit: false });
  });

  it('logs a shadow decision and does not act when per-bot entry is off', async () => {
    let called = 0;
    const logs: string[] = [];
    const gate = await jevEntryGate(
      { symbol: 'NVDA', bot_id: 41, bot_name: 'NVDA call', side: 'buy', source: 'bot', dte: 5, why: 'momo' },
      {
        mode: 'active',
        paper: true,
        apiKey: 'test-not-a-secret',
        botFlags: { entry: false, exit: false },
        now: 1_700_000_000_000,
        client: { async systemOne() { called++; return { answers: {} }; } },
        log: async (_f, line) => { logs.push(line); },
        budgetIo: { read: async () => null, write: async () => {}, log: () => {} },
      },
    );
    assert.equal(called, 0);
    assert.equal(gate.pick, 'enter');
    assert.equal(gate.failOpen, true);
    assert.equal(gate.applied, false);
    assert.equal(logs.length, 1);
    const rec = JSON.parse(logs[0]);
    assert.equal(rec.event, 'jev.entry');
    assert.equal(rec.applied, false);
    assert.equal(rec.called, false);
    assert.equal(rec.skipped, 'per_bot_off');
    assert.ok(rec.pick);
    assert.equal(rec.per_bot.entry, false);
    assert.ok(!logs[0].includes('test-not-a-secret'));
  });

  it('skips a second TypeSafe call while the exit decision is inside the cadence window', async () => {
    let called = 0;
    const logs: string[] = [];
    const client: JevClient = {
      async systemOne() {
        called++;
        return exitClient('exit').systemOne({ state: {}, questions: {} });
      },
    };
    const base = {
      symbol: 'QQQ',
      bot_id: 7,
      bot_name: 'Index',
      monitor_id: 90,
      occ: 'QQQ260920C00500000',
      dte: 2,
      fav: 4,
      peak: 6,
      trail_pct: 10,
      sl_pct: 10,
    };
    const deps = {
      mode: 'active' as const,
      paper: true,
      apiKey: 'test-not-a-secret',
      botFlags: { entry: true, exit: true },
      client,
      log: async (_f: string, line: string) => { logs.push(line); },
      budgetIo: { read: async () => null, write: async () => {}, log: () => {} },
    };
    const first = await jevExitGate(base, { ...deps, now: 1_800_000_000_000 });
    const second = await jevExitGate(base, { ...deps, now: 1_800_000_000_000 + 30_000 });
    assert.equal(first.called, true);
    assert.equal(first.pick, 'exit');
    assert.equal(first.applied, true);
    assert.equal(called, 1);
    assert.equal(second.called, false);
    assert.equal(second.skipped, 'cadence');
    assert.equal(second.pick, 'exit');
    assert.equal(logs.length, 1);
    assert.ok(JEV_CADENCE_SHORT_MS < JEV_CADENCE_MEDIUM_MS);
    assert.ok(JEV_CADENCE_MEDIUM_MS < JEV_CADENCE_LEAPS_MS);
    assert.equal(jevCadenceWindowMs(1), JEV_CADENCE_SHORT_MS);
    assert.equal(jevCadenceWindowMs(9), JEV_CADENCE_MEDIUM_MS);
    assert.equal(jevCadenceWindowMs(900, true), JEV_CADENCE_LEAPS_MS);
  });

  it('logs an exit decision outside regular hours and does not call TypeSafe', async () => {
    let called = 0;
    const logs: string[] = [];
    const gate = await jevExitGate({
      symbol: 'SPY',
      bot_id: 89,
      bot_name: 'wave',
      monitor_id: 8901,
      occ: 'SPY260930C00500000',
      dte: 2,
      fav: 4,
      peak: 6,
      trail_pct: 10,
      sl_pct: 10,
    }, {
      mode: 'active',
      paper: true,
      rth: false,
      apiKey: 'test-not-a-secret',
      botFlags: { entry: true, exit: true },
      now: 1_900_000_000_000,
      client: { async systemOne() { called++; return { answers: {} }; } },
      log: async (_f, line) => { logs.push(line); },
      budgetIo: { read: async () => null, write: async () => {}, log: () => {} },
    });
    assert.equal(called, 0);
    assert.equal(gate.called, false);
    assert.equal(gate.applied, false);
    assert.equal(gate.pick, 'hold');
    assert.equal(gate.skipped, 'rth_closed');
    assert.equal(logs.length, 1);
    const rec = JSON.parse(logs[0]);
    assert.equal(rec.skipped, 'rth_closed');
    assert.equal(rec.kind, 'exit');
  });

  it('still logs when exit scope is off outside regular hours', async () => {
    let called = 0;
    const logs: string[] = [];
    const gate = await jevExitGate({
      symbol: 'SPY',
      bot_id: 12,
      monitor_id: 1201,
      occ: 'SPY260930C00500000',
      dte: 5,
      fav: 1,
      peak: 2,
    }, {
      mode: 'active',
      paper: true,
      rth: false,
      botFlags: { entry: false, exit: false },
      now: 1_900_000_100_000,
      client: { async systemOne() { called++; return { answers: {} }; } },
      log: async (_f, line) => { logs.push(line); },
      budgetIo: { read: async () => null, write: async () => {}, log: () => {} },
    });
    assert.equal(called, 0);
    assert.equal(gate.skipped, 'per_bot_off');
    assert.equal(logs.length, 1);
  });

  it('replays a partial sell inside the window and does not turn it into a full close', async () => {
    let called = 0;
    const client: JevClient = {
      async systemOne() {
        called++;
        return exitClient('partial').systemOne({ state: {}, questions: {} });
      },
    };
    const base = {
      symbol: 'IWM',
      bot_id: 25,
      monitor_id: 2501,
      occ: 'IWM261016C00200000',
      dte: 9,
      fav: 3,
      peak: 4,
      qty: 4,
    };
    const deps = {
      mode: 'active' as const,
      paper: true,
      apiKey: 'test-not-a-secret',
      botFlags: { entry: true, exit: true },
      client,
      log: async () => {},
      budgetIo: { read: async () => null, write: async () => {}, log: () => {} },
    };
    const first = await jevExitGate(base, { ...deps, now: 1_910_000_000_000 });
    const second = await jevExitGate(base, { ...deps, now: 1_910_000_000_000 + 60_000 });
    assert.equal(first.pick, 'partial');
    assert.equal(first.applied, true);
    assert.equal(second.called, false);
    assert.equal(second.pick, 'partial');
    assert.equal(second.applied, true);
    assert.equal(called, 1);
  });

  it('uses the 2 minute exit window on expiry day inside the last 90 minutes', async () => {
    let called = 0;
    const client: JevClient = {
      async systemOne() {
        called++;
        return exitClient('hold').systemOne({ state: {}, questions: {} });
      },
    };
    const base = {
      symbol: 'QQQ',
      bot_id: 21,
      monitor_id: 2101,
      occ: 'QQQ260921C00500000',
      dte: 0,
      fav: 1,
      peak: 1,
    };
    const deps = {
      mode: 'active' as const,
      paper: true,
      minutesToClose: 40,
      apiKey: 'test-not-a-secret',
      botFlags: { entry: true, exit: true },
      client,
      log: async () => {},
      budgetIo: { read: async () => null, write: async () => {}, log: () => {} },
    };
    const t0 = 1_920_000_000_000;
    await jevExitGate(base, { ...deps, now: t0 });
    const inside = await jevExitGate(base, { ...deps, now: t0 + 90_000 });
    const after = await jevExitGate(base, { ...deps, now: t0 + 150_000 });
    assert.equal(inside.skipped, 'cadence');
    assert.equal(inside.called, false);
    assert.equal(after.called, true);
    assert.equal(called, 2);
  });

  it('exit advice cannot clear a hard stop or loosen the stop', () => {
    const rail = exitReason(-10, 0, { tp: 20, sl: 35, trail: 10 });
    assert.equal(rail, 'stop-loss');
    const held = resolveMonitorExit({
      railReason: rail,
      jev: { pick: 'hold', applied: true },
      trailPct: 10,
      slPct: 35,
      tpPct: 20,
      fav: -10,
      peak: 0,
    });
    assert.equal(held.reason, 'stop-loss');
    assert.equal(held.slPct, 35);
    assert.equal(held.trailPct, 10);

    const sold = resolveMonitorExit({
      railReason: 'stop-loss',
      jev: { pick: 'exit', applied: true },
      trailPct: 10,
      slPct: 10,
      tpPct: 20,
      fav: -10,
      peak: 2,
    });
    assert.equal(sold.reason, 'stop-loss');
    assert.equal(sold.slPct, 10);
    assert.equal(exitReason(-10, 2, { tp: 20, sl: sold.slPct, trail: sold.trailPct }), 'stop-loss');

    const gainRail = exitReason(1.4, 12, { tp: 20, sl: 10, trail: 10 });
    assert.equal(gainRail, 'gain-lock');
    const gain = resolveMonitorExit({
      railReason: gainRail,
      jev: { pick: 'hold', applied: true },
      trailPct: 10,
      slPct: 10,
      tpPct: 20,
      fav: 1.4,
      peak: 12,
    });
    assert.equal(gain.reason, 'gain-lock');
    assert.equal(gain.slPct, 10);
    assert.equal(gain.trailPct, 10);

    const tight = resolveMonitorExit({
      railReason: null,
      jev: { pick: 'tighten', applied: true },
      trailPct: 10,
      slPct: 10,
      tpPct: 20,
      fav: 3,
      peak: 4,
    });
    assert.equal(tight.slPct, 10);
    assert.ok(tight.trailPct < 10);
    assert.ok(tight.trailPct > 0);
    assert.equal(tightenTrail(10) <= 10, true);
    assert.equal(exitReason(-10, 4, { tp: 20, sl: tight.slPct, trail: tight.trailPct }), 'stop-loss');

    const shadowed = mergeJevExit({
      railReason: null,
      pick: 'exit',
      applied: false,
      trailPct: 10,
      slPct: 10,
    });
    assert.equal(shadowed.reason, null);
    assert.equal(shadowed.trailPct, 10);
    assert.equal(shadowed.slPct, 10);

    const acted = resolveMonitorExit({
      railReason: null,
      jev: { pick: 'exit', applied: true },
      trailPct: 10,
      slPct: 10,
      tpPct: 20,
      fav: 4,
      peak: 6,
    });
    assert.equal(acted.reason, 'jev-exit');
    assert.equal(acted.slPct, 10);
    assert.equal(exitReason(-10, 6, { tp: 20, sl: acted.slPct, trail: acted.trailPct }), 'stop-loss');
  });
});
