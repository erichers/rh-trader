import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { HEALTH_TONE_COLOR, QUIET_NEXT, STUCK_NEXT, deskHealth, nextAction, stripTone } from './deskHealth.ts';

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
    assert.equal(d.tone, 'ok');
    assert.equal(`${d.ready} ${d.exits} ${d.jev} ${d.muse}`.includes('$'), false);
    assert.equal(HEALTH_TONE_COLOR[d.tone].includes('green'), false);
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
    assert.equal(d.tone, 'bad');
  });

  it('warns on a degraded Jev without using the P&L green', () => {
    const d = deskHealth({
      ready: true, paper: true, env: 'alpaca_paper', live: false, swingLaw: swing, failures: [],
      jev: { enabled: true, mode: 'shadow', degraded: true },
      watch: { mode: 'observe' },
    });
    assert.equal(d.readyOk, true);
    assert.equal(d.tone, 'warn');
    assert.equal(HEALTH_TONE_COLOR.warn, '--health-warn');
    assert.equal(HEALTH_TONE_COLOR.bad, '--health-bad');
  });

  it('keeps the strip off green when a sell is stuck, even if the desk is ready', () => {
    const health = {
      ready: true, paper: true, env: 'alpaca_paper', live: false, swingLaw: swing, failures: [],
      jev: { enabled: true, mode: 'shadow' }, watch: { mode: 'observe' },
    };
    const monitors = [{ status: 'open', pending_exit_order_id: 9, entry_price: 100, last_price: 130 }];
    assert.equal(stripTone(health, false, monitors), 'bad');
    assert.equal(stripTone(health, false, []), 'ok');
    assert.equal(stripTone(health, false, null), 'warn');
  });
});

describe('next action', () => {
  const calm = {
    ready: true, paper: true, env: 'alpaca_paper', live: false, swingLaw: swing, failures: [],
    jev: { enabled: true, mode: 'shadow' }, watch: { mode: 'observe' },
  };

  it('stays quiet only when exits are known and nothing is stuck', () => {
    const a = nextAction(calm, false, []);
    assert.equal(a.label, QUIET_NEXT);
    assert.equal(a.tone, 'quiet');
    assert.equal(a.label.includes('$'), false);
  });

  it('does not say the rails are holding while monitors or the API are unknown', () => {
    assert.notEqual(nextAction(calm, false, null).label, QUIET_NEXT);
    assert.equal(nextAction(calm, true, []).label, 'API down');
    assert.equal(nextAction({ _unreachable: true }, false, []).tone, 'danger');
  });

  it('puts a stuck sell ahead of a calm book', () => {
    const a = nextAction(calm, false, [{ status: 'open', reason: 'EXIT STUCK' }]);
    assert.equal(a.label, STUCK_NEXT);
    assert.equal(a.tone, 'danger');
    assert.equal(a.href, '#/orders');
  });

  it('asks to arm exits when the gain-lock law is missing', () => {
    const a = nextAction({ ...calm, swingLaw: null }, false, []);
    assert.equal(a.label, 'Arm exits');
    assert.equal(a.tone, 'warn');
  });
});

describe('health colors stay off the P&L tokens', () => {
  it('maps the strip to --health-* and never --green or --red', () => {
    const css = readFileSync(new URL('./styles.css', import.meta.url), 'utf8');
    assert.match(css, /--glass:\s*rgba\(22, 23, 26, 0\.55\)/);
    assert.match(css, /--health-ok:/);
    assert.match(css, /--health-warn:/);
    assert.match(css, /--health-bad:/);
    assert.equal(css.includes('Robinhood-grade'), false);
    const chunk = css.slice(css.indexOf('.desk-health {'), css.indexOf('.rail-dots'));
    assert.equal(chunk.includes('var(--green)'), false);
    assert.equal(chunk.includes('var(--red)'), false);
    assert.match(chunk, /var\(--health-ok\)/);
    assert.match(chunk, /var\(--health-bad\)/);
  });
});
