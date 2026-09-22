import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { MAG7, UNIVERSE } from '../quickbot.js';
import { FOCUS_TICKERS } from '../focus.js';
import { STRATEGY_LIBRARY } from './strategies.js';
import {
  AI_BOOM_SYMBOLS,
  AI_BOOM_WATCH_NAME,
  aiBoomInserts,
  aiBoomPacks,
  coveragePrior,
  symbolsFor,
  watchSymbols,
} from './aiBoom.js';

describe('AI boom coverage', () => {
  const prior = coveragePrior({
    mag7: MAG7,
    universe: UNIVERSE,
    strategySymbols: STRATEGY_LIBRARY.map((s) => s.default_symbols),
    focus: [...FOCUS_TICKERS],
  });

  it('keeps GOOGL and does not add GOOG', () => {
    assert.equal(prior.googlInMag7, true);
    assert.equal(prior.googPresent, false);
    assert.equal(AI_BOOM_SYMBOLS.some((s) => s.symbol === 'GOOG'), false);
    assert.equal(MAG7.includes('GOOGL'), true);
  });

  it('treats missing AVGO and power or datacenter names as the gap', () => {
    assert.equal(prior.avgoInMag7, false);
    assert.equal(prior.avgoInUniverse, false);
    assert.deepEqual(prior.powerInUniverse, []);
    assert.deepEqual(prior.datacenterInUniverse, []);
    assert.match(prior.note, /does not include AVGO/);
    assert.match(prior.note, /off full auto/);
    assert.equal(prior.note.includes('—'), false);
  });

  it('puts AVGO on the chips pack and leaves thin names off the listed packs', () => {
    const chips = symbolsFor('chips', 'listed');
    assert.equal(chips[0], 'AVGO');
    assert.equal(chips.includes('CRDO'), false);
    assert.equal(symbolsFor('power', 'listed').includes('GEV'), false);
    assert.deepEqual(symbolsFor('datacenter'), ['EQIX', 'DLR', 'CCI']);
    assert.ok(watchSymbols().includes('AVGO'));
    assert.ok(watchSymbols().includes('CRDO'));
    assert.ok(watchSymbols().includes('GEV'));
  });

  it('seeds packs off, calls or LEAPS, Jev exit off', () => {
    for (const pack of aiBoomPacks()) {
      assert.equal(pack.fullAuto, false);
      assert.equal(pack.jevExit, false);
      assert.equal(pack.enabled, false);
      assert.ok(pack.badges.includes('Jev exit off'));
      assert.ok(pack.badges.includes('not full auto') || pack.badges.includes('watch only') || pack.kind === 'watch');
      for (const badge of pack.badges) assert.equal(badge.includes('—'), false);
    }
    const rows = aiBoomInserts();
    assert.equal(rows.some((r) => r.name === AI_BOOM_WATCH_NAME), true);
    for (const row of rows) {
      assert.equal(row.enabled, 0);
      assert.notEqual(row.mode, 'full_auto');
      assert.equal(row.asset_class, 'option');
      const jev = row.risk.jev as { entry: boolean; exit: boolean };
      assert.equal(jev.exit, false);
      assert.equal(jev.entry, false);
      const plays = row.action.plays as { direction?: string }[] | undefined;
      if (plays) assert.ok(plays.every((p) => p.direction === 'call'));
    }
    const watch = STRATEGY_LIBRARY.find((s) => s.name === AI_BOOM_WATCH_NAME);
    assert.deepEqual(watch?.default_symbols, watchSymbols());
    assert.equal(watch?.observe_only, true);
  });
});
