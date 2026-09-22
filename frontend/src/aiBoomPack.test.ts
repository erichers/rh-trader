import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { AI_BOOM_FALLBACK, aiBoomView, badgeKind } from './aiBoomPack.ts';

const SKIP = ['NVDA', 'AMD', 'AVGO', 'MU', 'META', 'MSFT', 'AMZN', 'TSLA', 'EOSE', 'RKLB'];
const DEFER = ['DLR', 'NRG', 'INTC', 'CLS', 'COHR'];

describe('Fox wait-for-signal desk copy', () => {
  it('shows the twelve names off, with SMCI strict and the skip list absent', () => {
    const view = aiBoomView(undefined);
    assert.equal(view.packs.length, 1);
    assert.equal(view.note.includes('—'), false);
    assert.equal(view.prior.includes('—'), false);
    const pack = view.packs[0];
    assert.deepEqual(pack.symbols, ['TSM', 'ASML', 'ANET', 'VRT', 'ARM', 'MRVL', 'CEG', 'VST', 'EQIX', 'ORCL', 'ETN', 'SMCI']);
    for (const symbol of SKIP) assert.equal(pack.symbols.includes(symbol), false, symbol);
    for (const symbol of DEFER) assert.equal(pack.symbols.includes(symbol), false, symbol);
    assert.deepEqual(view.deferred, DEFER);
    assert.deepEqual(view.skipped, SKIP);
    assert.equal(pack.fullAuto, false);
    assert.equal(pack.jevExit, false);
    assert.equal(pack.enabled, false);
    assert.ok(pack.badges.includes('Jev exit off'));
    assert.ok(pack.badges.includes('wait for signal'));
    assert.ok(pack.badges.includes('SMCI strict price'));
    for (const badge of pack.badges) assert.equal(badge.includes('—'), false);
    assert.equal(badgeKind('SMCI strict price'), 'amber');
    assert.equal(badgeKind('wait for signal'), 'blue');
    assert.equal(badgeKind('Jev exit off'), 'gray');
    assert.equal(AI_BOOM_FALLBACK.packs[0].id, 'fox-wait');
  });

  it('does not let a payload turn full auto or Jev exit on', () => {
    const view = aiBoomView({
      note: 'Paper only.',
      prior: 'Checked.',
      deferred: ['DLR'],
      skipped: ['NVDA'],
      packs: [{
        id: 'fox-wait',
        name: 'Fox wait for signal',
        kind: 'wait',
        symbols: ['TSM'],
        badges: ['Jev exit off'],
        fullAuto: true,
        jevExit: true,
        enabled: true,
      }],
    });
    assert.equal(view.packs[0].fullAuto, false);
    assert.equal(view.packs[0].jevExit, false);
    assert.equal(view.packs[0].enabled, false);
    assert.equal(view.packs[0].symbols[0], 'TSM');
    assert.deepEqual(view.deferred, ['DLR']);
  });
});
