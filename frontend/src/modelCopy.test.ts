import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { JEV_CADENCE_FALLBACK, JEV_EMPTY_PICK, jevScopeFlags, jevScopeLabel, jevSkipLabel } from './modelCopy.ts';

describe('Jev desk copy', () => {
  it('translates skip codes into desk language', () => {
    assert.equal(jevSkipLabel('per_bot_off'), 'scope off');
    assert.equal(jevSkipLabel('cadence'), 'still fresh');
    assert.equal(jevSkipLabel('budget'), 'budget spent');
    assert.equal(jevSkipLabel('paper_only'), 'paper only');
    assert.equal(jevSkipLabel(''), 'logged');
    assert.equal(jevSkipLabel(undefined), 'logged');
  });

  it('defaults per-bot scopes off and labels them', () => {
    assert.deepEqual(jevScopeFlags(undefined), { entry: false, exit: false });
    assert.deepEqual(jevScopeFlags({ stop_loss_pct: 10 }), { entry: false, exit: false });
    assert.deepEqual(jevScopeFlags('{"jev":{"exit":"true"}}'), { entry: false, exit: true });
    assert.equal(jevScopeLabel({ entry: false, exit: false }), 'off');
    assert.equal(jevScopeLabel({ entry: true, exit: true }), 'entry + exit');
  });

  it('uses the quiet-desk empty pick with no em dash', () => {
    assert.equal(JEV_EMPTY_PICK, 'No last pick yet. Either the bots are quiet, or Jev is off and the rails are flying solo.');
    assert.equal(JEV_EMPTY_PICK.includes('—'), false);
  });

  it('falls back to all four cadence bands', () => {
    assert.deepEqual(JEV_CADENCE_FALLBACK.map((b) => b.dte), ['0 to 3', '4 to 14', '15 to 179', '180 and out']);
    assert.equal(JEV_CADENCE_FALLBACK[2].every, '60 min');
  });
});
