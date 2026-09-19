import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  allowlistSkipReason,
  applyResolvedPremium,
  assignInferredAssetClass,
  draftNotionalUsd,
  inferAssetClass,
  lookupByOcc,
  looksLikeOptionPlay,
  occLookupKeys,
  optionPremium,
  pickNearestContract,
  quoteSides,
  twoSidedMid,
} from './optionPrice.js';

describe('optionPremium waterfall (max_position_usd path)', () => {
  it('uses two-sided mid when both bid and ask exist', () => {
    const p = optionPremium({ bid: 1.2, ask: 1.4 }, 'buy');
    assert.equal(p.price, 1.3);
    assert.equal(p.source, 'mid');
    assert.equal(p.placeable, true);
    assert.equal(p.decision.go, true);
  });

  it('prefers an explicit mid over last/close', () => {
    const p = optionPremium({ mid: 2.5, last: 9, close: 8 }, 'buy');
    assert.equal(p.price, 2.5);
    assert.equal(p.source, 'mid');
  });

  it('sizes a buy off ask when the quote is one-sided', () => {
    const p = optionPremium({ bid: null, ask: 3.1, last: 2.9 }, 'buy');
    assert.equal(p.price, 3.1);
    assert.equal(p.source, 'ask');
    assert.equal(p.placeable, true);
  });

  it('falls through to last trade when indicative latestQuote is empty', () => {
    // The Friday hole: snapshot has greeks + last, no bp/ap.
    const p = optionPremium({ last: 4.25, close: 4.1 }, 'buy');
    assert.equal(p.price, 4.25);
    assert.equal(p.source, 'last');
    assert.equal(p.placeable, false);
    assert.equal(p.decision.go, true);
  });

  it('uses prior close when that is the only mark', () => {
    const p = optionPremium({ close: 1.05 }, 'buy');
    assert.equal(p.price, 1.05);
    assert.equal(p.source, 'close');
  });

  it('does not treat a lone bid as a buyable premium', () => {
    const p = optionPremium({ bid: 2.2 }, 'buy');
    assert.equal(p.price, null);
    assert.equal(p.decision.go, false);
    assert.match(p.reason, /cannot size/);
  });

  it('fail-closes with a clear reason when every mark is missing', () => {
    const p = optionPremium({}, 'buy');
    assert.equal(p.price, null);
    assert.equal(p.source, null);
    assert.equal(p.decision.go, false);
    assert.equal(p.reason, 'no mid/ask/last/close — cannot size');
  });

  it('sells may size off the bid', () => {
    const p = optionPremium({ bid: 1.8 }, 'sell');
    assert.equal(p.price, 1.8);
    assert.equal(p.source, 'bid');
  });
});

describe('quoteSides + OCC lookup (Alpaca snapshot / contracts mismatch)', () => {
  it('reads bp/ap and long-name fields from a snapshot blob', () => {
    const a = quoteSides({ latestQuote: { bp: 1.1, ap: 1.3 }, latestTrade: { p: 1.2 }, dailyBar: { c: 1.0 } });
    assert.equal(a.bid, 1.1);
    assert.equal(a.ask, 1.3);
    assert.equal(a.last, 1.2);
    assert.equal(a.close, 1.0);
    const b = quoteSides({ bid_price: 0.4, ask_price: 0.6, close_price: 0.55 });
    assert.equal(b.bid, 0.4);
    assert.equal(b.ask, 0.6);
    assert.equal(b.close, 0.55);
    assert.equal(twoSidedMid(1, 2), 1.5);
  });

  it('matches space-padded OCC keys to compact contract symbols', () => {
    const compact = 'QQQ260925C00600000';
    const padded = 'QQQ   260925C00600000';
    const keys = occLookupKeys(compact);
    assert.ok(keys.includes(compact));
    assert.ok(keys.includes(padded));
    const snaps = { [padded]: { latestQuote: { bp: 2, ap: 2.2 } } };
    assert.equal(lookupByOcc(snaps, compact)?.latestQuote.ap, 2.2);
    assert.equal(lookupByOcc(snaps, padded)?.latestQuote.bp, 2);
    assert.equal(lookupByOcc({ other: 1 } as any, compact), undefined);
  });
});

describe('pickNearestContract prefers a priceable strike', () => {
  const chain = [
    { strike: 95, symbol: 'ITM', ask: null, last: null, close: null },
    { strike: 100, symbol: 'ATM', ask: 3.4, last: 3.2, close: 3.1 },
    { strike: 105, symbol: 'OTM', ask: null, last: null, close: null },
  ];
  const fields = (c: (typeof chain)[number]) => ({ ask: c.ask, last: c.last, close: c.close });

  it('walks off an unquoted ITM/OTM target onto the quoted ATM', () => {
    // 5% ITM on a $100 spot targets 95 — that row has no quote; ATM does.
    const hit = pickNearestContract(chain, 95, fields, 'buy');
    assert.equal(hit?.symbol, 'ATM');
  });

  it('returns the bare nearest strike when the whole expiry is unquoted (fail-closed upstream)', () => {
    const empty = [
      { strike: 95, symbol: 'A' },
      { strike: 100, symbol: 'B' },
    ];
    const hit = pickNearestContract(empty, 94, () => ({}), 'buy');
    assert.equal(hit?.symbol, 'A');
  });
});

describe('draftNotionalUsd — priceable vs unpriceable option sizing', () => {
  const optBuy = {
    asset_class: 'option' as const,
    side: 'buy' as const,
    qty: 1,
    option_type: 'call' as const,
    _play: { dte: 7, tag: 'call-7' },
  };

  it('computes contract notional (premium × 100) when a quote exists', () => {
    const n = draftNotionalUsd({ ...optBuy, est_price: 2.5 });
    assert.equal(n.unpriceableOptionBuy, false);
    assert.equal(n.notional, 250);
    assert.equal(n.assetClass, 'option');
    // $250 sits inside the $10k book / 50% daily-loss rails.
    assert.ok(n.notional <= 10_000);
  });

  it('sizes 2 contracts under the $10k cap', () => {
    const n = draftNotionalUsd({ ...optBuy, qty: 2, est_price: 8 });
    assert.equal(n.notional, 1600);
    assert.equal(n.unpriceableOptionBuy, false);
  });

  it('fail-closes a buy with a clear reason when every mark is missing', () => {
    const n = draftNotionalUsd({ ...optBuy, est_price: undefined, limit_price: undefined });
    assert.equal(n.notional, 0);
    assert.equal(n.unpriceableOptionBuy, true);
    assert.match(n.reason, /not priceable/);
    assert.match(n.reason, /notional_usd: 0/);
  });

  it('does not treat a sell as an unpriceable buy', () => {
    const n = draftNotionalUsd({ asset_class: 'option', side: 'sell', qty: 1 });
    assert.equal(n.unpriceableOptionBuy, false);
  });

  it('applyResolvedPremium writes est_price from last when mid/ask are empty', () => {
    const draft: { side: 'buy'; est_price?: number } = { side: 'buy' };
    const prem = applyResolvedPremium(draft, { last: 1.75 });
    assert.equal(draft.est_price, 1.75);
    assert.equal(prem.source, 'last');
    const sized = draftNotionalUsd({ ...optBuy, est_price: draft.est_price });
    assert.equal(sized.notional, 175);
    assert.equal(sized.unpriceableOptionBuy, false);
  });
});

describe('equity-vs-option allowlist (do not spray equity vetoes on an option play)', () => {
  it('infers option from option_type / _play / _contract even when asset_class is equity', () => {
    assert.equal(inferAssetClass({ asset_class: 'equity', option_type: 'call' }), 'option');
    assert.equal(inferAssetClass({ asset_class: 'equity', _play: { dte: 7, tag: 'call-7' } }), 'option');
    assert.equal(inferAssetClass({ asset_class: undefined, _contract: { occSymbol: 'QQQ260925C00600000' } }), 'option');
    assert.equal(looksLikeOptionPlay({ asset_class: 'equity' }), false);
    assert.equal(inferAssetClass({ asset_class: 'equity' }), 'equity');
  });

  it('rewrites a mislabeled draft so the allowlist sees option, not equity', () => {
    const draft = assignInferredAssetClass({
      asset_class: 'equity',
      option_type: 'call',
      strike_target: 'itm',
      expiration: '2026-09-25',
      _play: { dte: 7 },
    });
    assert.equal(draft.asset_class, 'option');
    assert.equal(allowlistSkipReason(draft.asset_class!, ['option']), null);
    // The Friday spray: unlabeled equity against an option-only desk.
    assert.match(allowlistSkipReason('equity', ['option']) || '', /equity.*allowlist \[option\]/);
    assert.equal(allowlistSkipReason('option', ['equity', 'etf', 'option']), null);
  });

  it('an inferred option draft with a premium is sizeable (not an equity allowlist miss)', () => {
    const draft = assignInferredAssetClass({
      asset_class: 'equity',
      option_type: 'put',
      side: 'buy',
      qty: 1,
      _play: { dte: 3 },
      est_price: 1.1,
    });
    const n = draftNotionalUsd(draft);
    assert.equal(n.assetClass, 'option');
    assert.equal(n.notional, 110);
    assert.equal(n.unpriceableOptionBuy, false);
    assert.equal(allowlistSkipReason(n.assetClass, ['option']), null);
  });
});
