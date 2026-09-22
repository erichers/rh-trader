import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { AI_BOOM_FALLBACK, aiBoomView, badgeKind } from './aiBoomPack.ts';

describe('AI boom desk copy', () => {
  it('shows honest badges and keeps Jev exit off', () => {
    const view = aiBoomView(undefined);
    assert.equal(view.packs.length, 6);
    assert.equal(view.note.includes('—'), false);
    assert.equal(view.prior.includes('—'), false);
    const chips = view.packs.find((p) => p.id === 'chips');
    assert.equal(chips?.symbols[0], 'AVGO');
    assert.equal(chips?.symbols.includes('GOOG'), false);
    assert.equal(view.packs.some((p) => p.symbols.includes('GOOG')), false);
    for (const pack of view.packs) {
      assert.equal(pack.fullAuto, false);
      assert.equal(pack.jevExit, false);
      assert.ok(pack.badges.includes('Jev exit off'));
      for (const badge of pack.badges) assert.equal(badge.includes('—'), false);
    }
    assert.equal(badgeKind('liquidity unverified'), 'amber');
    assert.equal(badgeKind('Jev exit off'), 'gray');
    assert.equal(AI_BOOM_FALLBACK.packs.find((p) => p.id === 'datacenter')?.badges.includes('liquidity unverified'), true);
  });

  it('does not let a payload turn full auto or Jev exit on', () => {
    const view = aiBoomView({
      note: 'Paper only.',
      prior: 'Checked.',
      packs: [{ id: 'chips', name: 'AI Chips Call Pack', kind: 'quickbot', symbols: ['AVGO'], badges: ['Jev exit off'], fullAuto: true, jevExit: true, enabled: true }],
    });
    assert.equal(view.packs[0].fullAuto, false);
    assert.equal(view.packs[0].jevExit, false);
    assert.equal(view.packs[0].enabled, false);
    assert.equal(view.packs[0].symbols[0], 'AVGO');
  });
});
