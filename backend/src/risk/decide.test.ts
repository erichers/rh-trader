import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { choice, choiceConfidence, decideGo, gate, score, FAIL, PASS, UNKNOWN } from './decide.js';

describe('TypeSafe-style Choice / Score', () => {
  it('computes Choice confidence as distance from a uniform prior', () => {
    assert.equal(choiceConfidence(1, 2), 1);
    assert.equal(choiceConfidence(0.5, 2), 0);
    // 3-way, pmax 0.8 → (0.8 - 1/3) / (1 - 1/3) = 0.7
    assert.ok(Math.abs(choiceConfidence(0.8, 3) - 0.7) < 1e-9);
  });

  it('fail-closes on fail or unknown Choice', () => {
    const go = decideGo({ answers: [gate({ id: 'a', pick: PASS, because: 'ok' })] });
    assert.equal(go.go, true);
    const no = decideGo({ answers: [gate({ id: 'a', pick: FAIL, because: 'blocked' })] });
    assert.equal(no.go, false);
    assert.match(no.because, /blocked/);
    const unk = decideGo({ answers: [gate({ id: 'a', pick: UNKNOWN, because: 'missing' })] });
    assert.equal(unk.go, false);
  });

  it('fail-closes a Score below its floor', () => {
    const tight = score({ id: 't', levels: ['missing', 'loose', 'ok'], value: 2, because: 'ok' });
    assert.equal(decideGo({ answers: [tight], scoreFloors: { t: 2 } }).go, true);
    const loose = score({ id: 't', levels: ['missing', 'loose', 'ok'], value: 1, because: 'loose' });
    assert.equal(decideGo({ answers: [loose], scoreFloors: { t: 2 } }).go, false);
  });

  it('records typed evidence instead of stringly deciding', () => {
    const c = choice({
      id: 'window',
      options: ['in', 'out'] as const,
      pick: 'in',
      because: '7DTE',
      evidence: { dte: 7 },
    });
    assert.equal(c.choice, 'in');
    assert.equal(c.evidence.dte, 7);
    assert.equal(c.probabilities.in, 1);
  });
});
