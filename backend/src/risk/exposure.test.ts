import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  orderBuyNotional,
  splitInflightBuys,
  openSymbolExposureUsd,
  evaluateSymbolCaps,
  reserveBuyNotional,
  releaseBuyNotional,
  reservedBuyNotional,
  _resetReservations,
  fitBuyToSymbolBook,
  sharedBookCap,
} from './exposure.js';

describe('orderBuyNotional', () => {
  it('uses filled / limit / draft.est_price and ×100 for options', () => {
    assert.equal(orderBuyNotional({ qty: 7, filled_price: 652.38, asset_class: 'equity' }), 7 * 652.38);
    assert.equal(orderBuyNotional({ qty: 10, limit_price: 100, asset_class: 'equity' }), 1000);
    assert.equal(orderBuyNotional({
      qty: 5, asset_class: 'equity',
      raw: { draft: { est_price: 650 } },
    }), 3250);
    assert.equal(orderBuyNotional({ qty: 1, filled_price: 4.2, asset_class: 'option' }), 420);
  });

  it('does not treat missing prices as $0 exposure that slips the cap', () => {
    assert.equal(orderBuyNotional({ qty: 21, asset_class: 'equity', raw: '{}' }), 0);
  });
});

describe('splitInflightBuys + openSymbolExposureUsd', () => {
  it('counts staged/placed as pending and ignores drafts/vetoes', () => {
    const etDay = '2026-09-10';
    const { pendingUsd, todayFilledUsd } = splitInflightBuys([
      { status: 'placed', qty: 5, filled_price: 100, asset_class: 'equity' },
      { status: 'staged', qty: 2, limit_price: 100, asset_class: 'equity' },
      { status: 'draft', qty: 99, filled_price: 100, asset_class: 'equity' },
      { status: 'vetoed', qty: 99, filled_price: 100, asset_class: 'equity' },
      { status: 'filled', qty: 3, filled_price: 100, asset_class: 'equity', created_at: '2026-09-10T14:00:00Z' },
    ], etDay);
    assert.equal(pendingUsd, 700);
    assert.equal(todayFilledUsd, 300);
  });

  it('uses max(position, today fills) so a stale snapshot cannot hide same-day buys', () => {
    assert.equal(openSymbolExposureUsd({
      positionMv: 0, todayFilledUsd: 4566, pendingUsd: 4566, reservedUsd: 0,
    }), 9132);
    assert.equal(openSymbolExposureUsd({
      positionMv: 4566, todayFilledUsd: 4566, pendingUsd: 0, reservedUsd: 0,
    }), 4566);
  });
});

describe('evaluateSymbolCaps — META three-bot stack', () => {
  const equity = 50_000;
  const maxPositionUsd = 10_000;
  const maxConcentrationPct = 25; // $12,500 of $50k

  it('each ticket under $10k still fails when the symbol book would exceed max position', () => {
    const t1 = evaluateSymbolCaps({
      side: 'buy', ticketNotional: 4566, openUsd: 0, equity, maxPositionUsd, maxConcentrationPct,
    });
    assert.equal(t1.ticketOk, true);
    assert.equal(t1.positionOk, true);
    assert.equal(t1.concentrationOk, true);

    const t2 = evaluateSymbolCaps({
      side: 'buy', ticketNotional: 4566, openUsd: 4566, equity, maxPositionUsd, maxConcentrationPct,
    });
    assert.equal(t2.ticketOk, true);
    assert.equal(t2.positionOk, true); // 9132 <= 10000
    assert.equal(t2.concentrationOk, true);

    const t3 = evaluateSymbolCaps({
      side: 'buy', ticketNotional: 4566, openUsd: 9132, equity, maxPositionUsd, maxConcentrationPct,
    });
    assert.equal(t3.ticketOk, true);
    assert.equal(t3.positionOk, false); // 13698 > 10000
    assert.match(t3.positionDetail, /symbol book across bots/);
  });

  it('vetoes a ticket that is under max position but would breach 25% concentration', () => {
    const r = evaluateSymbolCaps({
      side: 'buy',
      ticketNotional: 4000,
      openUsd: 9000,          // already 18%
      equity: 50_000,
      maxPositionUsd: 20_000, // ticket + book still under $20k
      maxConcentrationPct: 25,
    });
    assert.equal(r.ticketOk, true);
    assert.equal(r.positionOk, true);
    assert.equal(r.concentrationOk, false);
    assert.equal(r.concentrationPct, 26);
  });

  it('Monday META replay: third $4.5k ticket fails the $10k book (auto and full_auto share this math)', () => {
    const third = evaluateSymbolCaps({
      side: 'buy', ticketNotional: 4566, openUsd: 9132, equity, maxPositionUsd, maxConcentrationPct,
    });
    assert.equal(third.ticketOk, true);
    assert.equal(third.positionOk, false);
    assert.ok(third.stackedUsd > 10_000);
  });

  it('does not apply new-exposure caps to sells', () => {
    const r = evaluateSymbolCaps({
      side: 'sell', ticketNotional: 20_000, openUsd: 20_000, equity, maxPositionUsd, maxConcentrationPct,
    });
    assert.equal(r.ticketOk, true);
    assert.equal(r.positionOk, true);
    assert.equal(r.concentrationOk, true);
  });
});

describe('shared symbol book — Index QuickBot style', () => {
  const desk = 10_000;
  const botCap = sharedBookCap(3500, desk);

  it('uses the tighter of the bot cap and the desk $10k', () => {
    assert.equal(botCap, 3500);
    assert.equal(sharedBookCap(15_000, desk), 10_000);
  });

  it('skips the next same-symbol ticket once the shared book is full instead of stacking a veto', () => {
    let open = 0;
    const unit = 1600;
    const steps = [1, 2, 3].map(() => {
      const fit = fitBuyToSymbolBook({ qty: 1, unitCost: unit, openUsd: open, maxPositionUsd: botCap });
      if (fit.action !== 'skip') open += fit.notional;
      return fit.action;
    });
    assert.deepEqual(steps, ['pass', 'pass', 'skip']);
    assert.ok(open <= 3500);
    assert.match(fitBuyToSymbolBook({ qty: 1, unitCost: unit, openUsd: open, maxPositionUsd: botCap }).reason, /skip before draft/);
  });

  it('sizes a later bot down into the room left under the desk cap', () => {
    const first = fitBuyToSymbolBook({ qty: 2, unitCost: 4000, openUsd: 0, maxPositionUsd: sharedBookCap(10_000, desk) });
    assert.equal(first.action, 'pass');
    const second = fitBuyToSymbolBook({ qty: 2, unitCost: 2000, openUsd: first.notional, maxPositionUsd: 10_000 });
    assert.equal(second.action, 'size_down');
    assert.equal(second.qty, 1);
    assert.equal(second.notional, 2000);
    const third = fitBuyToSymbolBook({ qty: 1, unitCost: 2000, openUsd: first.notional + second.notional, maxPositionUsd: 10_000 });
    assert.equal(third.action, 'skip');
  });

  it('stops a second bot when concentration room is gone even if the ticket is under the position cap', () => {
    const fit = fitBuyToSymbolBook({
      qty: 1,
      unitCost: 2000,
      openUsd: 9000,
      maxPositionUsd: 10_000,
      equity: 40_000,
      maxConcentrationPct: 25,
    });
    assert.equal(fit.action, 'skip');
  });
});

describe('in-process reservation', () => {
  beforeEach(() => _resetReservations());

  it('stacks concurrent bot tickets on the same symbol before either insert lands', () => {
    reserveBuyNotional('alpaca_paper', 'META', 4566);
    reserveBuyNotional('alpaca_paper', 'meta', 4566);
    assert.equal(reservedBuyNotional('alpaca_paper', 'META'), 9132);
    releaseBuyNotional('alpaca_paper', 'META', 4566);
    assert.equal(reservedBuyNotional('alpaca_paper', 'META'), 4566);
  });
});
