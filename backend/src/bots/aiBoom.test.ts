import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { MAG7, UNIVERSE } from '../quickbot.js';
import { FOCUS_TICKERS } from '../focus.js';
import { STRATEGY_LIBRARY } from './strategies.js';
import {
  FOX_DEFER,
  FOX_SKIP,
  FOX_WAIT,
  aiBoomInserts,
  aiBoomPacks,
  aiBoomPublic,
  coveragePrior,
  foxBotName,
} from './aiBoom.js';

describe('Fox wait-for-signal pack', () => {
  const prior = coveragePrior({
    mag7: MAG7,
    universe: UNIVERSE,
    strategySymbols: STRATEGY_LIBRARY.map((s) => s.default_symbols),
    focus: [...FOCUS_TICKERS],
  });

  it('keeps GOOGL and does not add GOOG', () => {
    assert.equal(prior.googlInMag7, true);
    assert.equal(prior.googPresent, false);
    assert.equal(FOX_WAIT.includes('GOOG' as never), false);
    assert.equal(MAG7.includes('GOOGL'), true);
  });

  it('uses the twelve names and leaves the skip and defer lists off the bots', () => {
    assert.deepEqual([...FOX_WAIT], ['TSM', 'ASML', 'ANET', 'VRT', 'ARM', 'MRVL', 'CEG', 'VST', 'EQIX', 'ORCL', 'ETN', 'SMCI']);
    for (const symbol of FOX_SKIP) assert.equal(FOX_WAIT.includes(symbol as never), false, symbol);
    for (const symbol of FOX_DEFER) assert.equal(FOX_WAIT.includes(symbol as never), false, symbol);
    assert.equal(prior.note.includes('—'), false);
    assert.match(prior.note, /stay off/);
    assert.match(prior.note, /SMCI/);
    assert.ok(prior.alreadyOnDesk.includes('CEG'));
    assert.equal(STRATEGY_LIBRARY.some((s) => /AI Boom Watch|AVGO Broadcom|AVGO LEAPS/.test(s.name)), false);
  });

  it('seeds each name off, calls 2-14, Jev exit off, SMCI strict', () => {
    const packs = aiBoomPacks();
    assert.equal(packs.length, 1);
    assert.deepEqual(packs[0].symbols, [...FOX_WAIT]);
    for (const pack of packs) {
      assert.equal(pack.fullAuto, false);
      assert.equal(pack.jevExit, false);
      assert.equal(pack.enabled, false);
      assert.ok(pack.badges.includes('Jev exit off'));
      assert.ok(pack.badges.includes('wait for signal'));
      assert.ok(pack.badges.includes('SMCI strict price'));
      for (const badge of pack.badges) assert.equal(badge.includes('—'), false);
    }
    const rows = aiBoomInserts();
    assert.equal(rows.length, FOX_WAIT.length);
    assert.deepEqual(rows.map((r) => r.name), FOX_WAIT.map(foxBotName));
    for (const row of rows) {
      assert.equal(row.enabled, 0);
      assert.equal(row.mode, 'observe');
      assert.equal(row.asset_class, 'option');
      assert.equal(row.action.option_type, 'call');
      assert.equal(row.action.expiration, 'weekly');
      assert.equal(row.action._wait_for_signal, true);
      assert.equal(row.action._observe_only, undefined);
      assert.equal(row.risk.max_position_usd, 900);
      const jev = row.risk.jev as { entry: boolean; exit: boolean };
      assert.equal(jev.exit, false);
      assert.equal(jev.entry, false);
      const symbol = row.symbols[0];
      if (symbol === 'SMCI') {
        assert.equal(row.action._strict_price, true);
        assert.equal(row.risk._strict_price, true);
      } else {
        assert.equal(row.action._strict_price, undefined);
      }
    }
    const pub = aiBoomPublic(prior.note);
    assert.deepEqual(pub.deferred, [...FOX_DEFER]);
    assert.deepEqual(pub.skipped, [...FOX_SKIP]);
    assert.equal(pub.note.includes('—'), false);
    assert.equal(rows.some((r) => FOX_SKIP.includes(r.symbols[0] as never)), false);
  });
});
