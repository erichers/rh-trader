import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  JEV_USD_PER_1K_INPUT,
  canCallJevApi,
  defaultSpend,
  estimateCallUsd,
  isPaymentOrCreditError,
  jevHealthSnapshot,
  recordJevUsage,
  remainingUsd,
  resetJevBudgetForTests,
  shouldDegrade,
} from './jevBudget.js';
import { composeLocalJev, fallbackJevGate, localJevPanel } from './jevFallback.js';
import { jevEntryGate, type JevClient } from './jev.js';

describe('Jev $5 budget', () => {
  beforeEach(() => resetJevBudgetForTests());

  it('overestimates TypeSafe input price slightly', () => {
    assert.ok(JEV_USD_PER_1K_INPUT > 0.000042);
    assert.ok(estimateCallUsd(1_000_000) > 0.04);
    assert.ok(estimateCallUsd(1_000_000) <= 0.06);
  });

  it('trips degrade when remaining ≤ reserve', () => {
    const s = defaultSpend({ spentUsd: 4.55, budgetUsd: 5, reserveUsd: 0.5 });
    assert.ok(remainingUsd(s) <= 0.5);
    assert.equal(shouldDegrade(s), true);
    assert.equal(canCallJevApi(s), false);
    const h = jevHealthSnapshot(s, 'shadow');
    assert.equal(h.degraded, true);
    assert.equal(h.ok, false);
    assert.equal(h.budgetUsd, 5);
  });

  it('payment/credit errors trip degrade', () => {
    assert.equal(isPaymentOrCreditError('payment required', 402), true);
    assert.equal(isPaymentOrCreditError('insufficient credit', 429), true);
    assert.equal(isPaymentOrCreditError('bad key', 401), false);
  });

  it('recordJevUsage persists spend and degrades on 402', async () => {
    const mem = { json: '' };
    const io = {
      read: async () => mem.json || null,
      write: async (j: string) => { mem.json = j; },
      log: () => {},
    };
    const after = await recordJevUsage({ inputTokens: 20_000, io });
    assert.ok(after.spentUsd > 0);
    const paid = await recordJevUsage({ error: '402 payment required', status: 402, io });
    assert.equal(paid.degraded, true);
    assert.equal(canCallJevApi(paid), false);
    assert.match(String(paid.reason), /payment/);
  });
});

describe('Jev elegant fallback', () => {
  it('local decide never throws and shadow stays fail-open', () => {
    const panel = localJevPanel({ symbol: 'QQQ', signal_why: 'Fired: RSI reclaim', open_positions_count: 2 });
    assert.ok((panel.signal_coherent ?? 0) > 0.5);
    const g = composeLocalJev({ symbol: 'QQQ', signal_why: 'Fired: RSI reclaim' }, 'shadow');
    assert.equal(g.pick, 'enter');
    assert.equal(g.failOpen, true);
    assert.match(g.because, /fallback/);
  });

  it('budget trip → jevEntryGate uses fallback, does not call TypeSafe', async () => {
    resetJevBudgetForTests();
    let called = 0;
    const client: JevClient = {
      async systemOne() {
        called++;
        return { answers: { action: { type: 'choice', choice: 'skip', confidence: 0.99 } } };
      },
    };
    const mem = {
      json: JSON.stringify({
        spentUsd: 4.6, budgetUsd: 5, reserveUsd: 0.5, degraded: true,
        reason: 'reserve', warned50: true, warned80: true, updatedAt: new Date().toISOString(),
      }),
    };
    const gate = await jevEntryGate(
      { symbol: 'TSLA', why: 'Fired: momentum', dte_or_leaps: 'leaps:850', side: 'buy', source: 'bot' },
      {
        apiKey: 'test-not-a-secret',
        mode: 'shadow',
        client,
        budgetIo: {
          read: async () => mem.json,
          write: async (j: string) => { mem.json = j; },
          log: () => {},
        },
      },
    );
    assert.equal(called, 0);
    assert.equal(gate.pick, 'enter');
    assert.equal(gate.failOpen, true);
    assert.match(gate.because, /fallback|degraded|reserve/i);
  });

  it('optional LLM skip is honored only in active fallback', async () => {
    const skip = await fallbackJevGate(
      { symbol: 'NVDA', signal_why: 'Fired: EMA cross' },
      'active',
      { llmReview: async () => ({ go: false, because: 'crowded tape' }) },
    );
    assert.equal(skip.pick, 'skip');
    assert.equal(skip.failOpen, false);
    assert.equal(skip.via, 'local_decide+llm');

    const shadow = await fallbackJevGate(
      { symbol: 'NVDA', signal_why: 'Fired: EMA cross' },
      'shadow',
      { llmReview: async () => ({ go: false, because: 'crowded tape' }) },
    );
    assert.equal(shadow.pick, 'enter');
    assert.equal(shadow.failOpen, true);
  });
});
