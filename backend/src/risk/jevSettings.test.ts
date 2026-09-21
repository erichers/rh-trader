import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  effectiveJevMode,
  loadJevSettings,
  parseJevUiMode,
  resetJevSettingsForTests,
  saveJevSettings,
  seedJevSettings,
} from './jevSettings.js';
import { jevEntryGate, resetJevLastForTests, type JevClient } from './jev.js';
import { resetJevBudgetForTests } from './jevBudget.js';

describe('Jev durable settings', () => {
  beforeEach(() => {
    resetJevSettingsForTests();
    resetJevBudgetForTests();
    resetJevLastForTests();
  });

  it('parses off / shadow / active; env seed is not off', () => {
    assert.equal(parseJevUiMode('off'), 'off');
    assert.equal(parseJevUiMode('ACTIVE'), 'active');
    assert.equal(parseJevUiMode(''), 'shadow');
    const seed = seedJevSettings();
    assert.ok(seed.mode === 'shadow' || seed.mode === 'active');
    assert.equal(effectiveJevMode({ enabled: false, mode: 'shadow' }), 'off');
    assert.equal(effectiveJevMode({ enabled: true, mode: 'off' }), 'off');
  });

  it('PUT mode=off disables; enable flips off → shadow', async () => {
    const mem: { s: any } = { s: null };
    const io = {
      get: async () => mem.s,
      set: async (s: any) => { mem.s = s; },
    };
    const off = await saveJevSettings({ mode: 'off' }, io);
    assert.equal(off.mode, 'off');
    assert.equal(off.enabled, false);
    resetJevSettingsForTests();
    const on = await saveJevSettings({ enabled: true }, io);
    assert.equal(on.enabled, true);
    assert.equal(on.mode, 'shadow');
  });

  it('off never calls TypeSafe and fail-opens', async () => {
    let called = 0;
    const client: JevClient = {
      async systemOne() {
        called++;
        return { answers: { action: { type: 'choice', choice: 'skip', confidence: 0.99 } } };
      },
    };
    const gate = await jevEntryGate(
      { symbol: 'TSLA', why: 'Fired', side: 'buy', source: 'bot' },
      { apiKey: 'test-not-a-secret', mode: 'off', client },
    );
    assert.equal(called, 0);
    assert.equal(gate.pick, 'enter');
    assert.equal(gate.failOpen, true);
    assert.match(gate.because, /off/);
  });

  it('persisted settings load through injectable io', async () => {
    const mem = { s: { enabled: true, mode: 'active' as const } };
    const s = await loadJevSettings({ get: async () => mem.s });
    assert.equal(effectiveJevMode(s), 'active');
  });
});
