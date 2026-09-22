import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { resetUsageLogForTests, usageChoice, usageRouterSync } from './usageRouter.js';

describe('usage router', () => {
  it('never gates posts, spend, or a stuck-sell retry', () => {
    for (const lane of ['post', 'spend', 'retry'] as const) {
      const route = usageRouterSync({ lane, label: lane, mode: 'active', marketOpen: false });
      assert.equal(route.choice, 'do');
      assert.equal(route.proceed, true);
      assert.equal(route.applied, false);
      assert.match(route.because, /never gated/);
    }
  });

  it('shadow logs a skip and still proceeds', () => {
    resetUsageLogForTests();
    const route = usageRouterSync({
      lane: 'wake',
      label: 'newsAi',
      mode: 'shadow',
      marketOpen: false,
      material: false,
    });
    assert.equal(route.choice, 'skip');
    assert.equal(route.proceed, true);
    assert.equal(route.applied, false);
    assert.equal(route.mode, 'shadow');
  });

  it('active skip holds a closed-market wake', () => {
    const route = usageRouterSync({
      lane: 'compute',
      label: 'learning',
      mode: 'active',
      marketOpen: false,
    });
    assert.equal(route.choice, 'skip');
    assert.equal(route.proceed, false);
    assert.equal(route.applied, true);
  });

  it('escalates when paper positions are open', () => {
    const answer = usageChoice({
      lane: 'wake',
      label: 'muse.watch',
      material: true,
      openPositions: 2,
      marketOpen: true,
    });
    assert.equal(answer.choice, 'escalate');
    const route = usageRouterSync({
      lane: 'wake',
      label: 'muse.watch',
      mode: 'active',
      material: true,
      openPositions: 2,
    });
    assert.equal(route.proceed, true);
    assert.equal(route.choice, 'escalate');
  });

  it('uses the Choice confidence formula and avoids an em dash', () => {
    const answer = usageChoice({ lane: 'wake', label: 'embed', marketOpen: true });
    assert.equal(answer.kind, 'choice');
    assert.ok(answer.confidence > 0);
    assert.equal(answer.because.includes('—'), false);
  });
});
