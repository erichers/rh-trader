import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { holdChecklistItems, isSignalHold, promoteHoldDecision } from './signalHold.js';

describe('signal hold', () => {
  it('treats _ai_boom and wait-for-signal as the same fail-closed hold', () => {
    assert.equal(isSignalHold({ _ai_boom: true }), true);
    assert.equal(isSignalHold({ _wait_for_signal: true }), true);
    assert.equal(isSignalHold({ _fox: 'wait' }), true);
    assert.equal(isSignalHold({ _full_auto_ok: true }), false);
  });

  it('blocks checklist promote unless force carries a written reason, and still does not enable trading', () => {
    const bot = { id: 70, name: 'TSM wait for signal', action: { _ai_boom: true, _wait_for_signal: true }, risk: {} };
    const items = holdChecklistItems(bot);
    assert.equal(items[0].key, 'wait_for_signal');
    assert.equal(items[0].pass, false);
    assert.equal(items[0].critical, true);
    assert.equal(promoteHoldDecision(bot, { force: true }).kind, 'blocked');
    assert.equal(promoteHoldDecision(bot, { force: true, reason: 'short' }).kind, 'blocked');
    const armed = promoteHoldDecision(bot, { force: true, reason: 'desk arm after checklist' });
    assert.equal(armed.kind, 'arm_stamp');
    const plain = { id: 4, name: 'Donchian', action: { option_type: 'call' }, risk: {} };
    assert.equal(promoteHoldDecision(plain, {}).kind, 'none');
  });

  it('fails 0-DTE closed, including bot 84, even with force', () => {
    const bot = { id: 84, name: 'SPY scalp', action: { _dte: 0, expiration: '0dte' }, risk: {} };
    const items = holdChecklistItems(bot);
    assert.ok(items.some((it) => it.key === 'zero_dte' && it.pass === false));
    const held = promoteHoldDecision(bot, { force: true, reason: 'desk arm after checklist' });
    assert.equal(held.kind, 'blocked');
    if (held.kind === 'blocked') assert.equal(held.code, 'zero_dte');
    const named = promoteHoldDecision({ id: 9, name: 'QQQ 0-DTE', action: {}, risk: {} }, { force: true, reason: 'desk arm after checklist' });
    assert.equal(named.kind, 'blocked');
  });
});
