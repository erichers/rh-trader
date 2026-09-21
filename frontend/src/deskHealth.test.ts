import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { deskHealth } from './deskHealth.ts';

const swing = { hardStopPct: 10, gainLockArmPct: 10, gainLockFloorPct: 1.5 };

describe('desk health strip', () => {
  it('shows Ready, exits armed, and both modes when the paper desk is up', () => {
    const d = deskHealth({
      ready: true, paper: true, env: 'alpaca_paper', live: false, swingLaw: swing, failures: [],
      jev: { enabled: true, mode: 'shadow' },
      watch: { mode: 'improve' },
    });
    assert.equal(d.ready, 'Ready');
    assert.equal(d.readyOk, true);
    assert.equal(d.exits, 'Exits armed');
    assert.equal(d.jev, 'Jev shadow');
    assert.equal(d.muse, 'Muse improve');
    assert.equal(`${d.ready} ${d.exits} ${d.jev} ${d.muse}`.includes('$'), false);
  });

  it('replaces Ready with the first failure', () => {
    const d = deskHealth({
      ready: false, paper: true, env: 'alpaca_paper', failures: ['alpaca_unreachable', 'db_down'],
      swingLaw: swing, jev: { enabled: false, mode: 'off' }, watch: { mode: 'observe' },
    });
    assert.equal(d.ready, 'Alpaca down');
    assert.equal(d.readyOk, false);
    assert.equal(d.exits, 'Exits armed');
    assert.equal(d.jev, 'Jev off');
    assert.equal(d.muse, 'Muse observe');
  });

  it('says API down when the desk cannot be read', () => {
    const d = deskHealth({ _unreachable: true, ready: true }, true);
    assert.equal(d.ready, 'API down');
    assert.equal(d.exits, 'Exits unknown');
    assert.equal(d.jev, 'Jev unknown');
    assert.equal(d.muse, 'Muse unknown');
  });
});
