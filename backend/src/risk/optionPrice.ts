/**
 * Option premium used by max_position_usd / sizeDraft.
 *
 * Friday 2026-09-18 paper zero-fill: ~1633 option buys died with
 * `option buy not priceable — cannot size` (notional_usd: 0) even when DTE
 * passed. Trace of that path:
 *
 *   resolveDraftContract → resolveContract → getChain → est_price = mid ?? ask
 *   riskCheck notional = est_price * qty * 100
 *   unpriceableOptionBuy when notional === 0
 *
 * Two holes sat on that path:
 *   1. getChain treated "snapshot exists" as "quoted". Indicative snapshots
 *      often carry greeks/IV and an empty latestQuote — we never fell through
 *      to /options/quotes/latest, and we ignored last trade + close.
 *   2. Snapshot / quote maps are keyed by OCC; contracts API and the data
 *      API disagree on space-padding. A miss left mid/ask null.
 *
 * This module is the single waterfall + OCC lookup + asset-class inference.
 * Placement still refuses a naked market order; a priced limit is required.
 *
 * Go/no-go uses the local TypeSafe / System One Choice gate (no paid SDK).
 */

import { decideGo, gate, FAIL, PASS, UNKNOWN, type Decision } from './decide.js';

export const CONTRACT_MULT = 100;

export type PremiumSource = 'mid' | 'ask' | 'bid' | 'last' | 'close';

export type OptionQuoteFields = {
  mid?: number | null;
  bid?: number | null;
  ask?: number | null;
  last?: number | null;
  close?: number | null;
};

export type OptionPremium = {
  price: number | null;
  source: PremiumSource | null;
  reason: string;
  /** True when a buy can be sent as a limit (mid or ask). last/close size only. */
  placeable: boolean;
  evidence: Record<string, number | string | null>;
  decision: Decision;
};

function pos(v: unknown): number | null {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Read Alpaca (bp/ap) and long-name quote shapes from a snapshot, quote, or trade blob. */
export function quoteSides(raw: any): { bid: number | null; ask: number | null; last: number | null; close: number | null } {
  const q = raw || {};
  const lq = q.latestQuote || q.quote || q;
  const lt = q.latestTrade || q.trade || {};
  const bar = q.dailyBar || q.prevDailyBar || q.bar || {};
  return {
    bid: pos(lq.bp ?? lq.bid ?? lq.bid_price ?? q.bp ?? q.bid ?? q.bid_price),
    ask: pos(lq.ap ?? lq.ask ?? lq.ask_price ?? q.ap ?? q.ask ?? q.ask_price),
    last: pos(lt.p ?? lt.price ?? q.p ?? q.last ?? q.price),
    close: pos(q.close_price ?? q.close ?? bar.c ?? bar.close),
  };
}

export function twoSidedMid(bid: number | null, ask: number | null): number | null {
  // A missing side used to be stored as 0 on /quotes/latest (`bid ?? 0`).
  // (0 + ask) / 2 is not a market — require two positive prices.
  const b = pos(bid);
  const a = pos(ask);
  if (b != null && a != null) return round2((b + a) / 2);
  return null;
}

const MARK_KEYS = ['mid', 'bid', 'ask', 'last', 'close'] as const;

/** First positive mark wins per field. Used to join snapshot + /quotes/latest. */
export function mergeQuoteFields(...sources: Array<OptionQuoteFields | null | undefined>): OptionQuoteFields {
  const out: OptionQuoteFields = {};
  for (const s of sources) {
    if (!s) continue;
    for (const k of MARK_KEYS) {
      if (out[k] == null) {
        const n = pos(s[k]);
        if (n != null) out[k] = n;
      }
    }
  }
  return out;
}

/** Same moneyness math resolveContract uses. ITM call = 5% below spot, not "no OCC". */
export function strikeTargetPrice(spot: number, type: 'call' | 'put', strikeTarget: string): number {
  if (strikeTarget === 'atm' || !spot) return spot;
  const otm = strikeTarget === 'otm';
  const up = (type === 'call') === otm;
  return up ? spot * 1.05 : spot * 0.95;
}

/**
 * Sizing waterfall for one contract. Buys prefer mid → ask → last → close.
 * A one-sided bid is not a buyable offer. Missing everything fails closed.
 */
export function optionPremium(fields: OptionQuoteFields, side: 'buy' | 'sell' = 'buy', opts?: { strict?: boolean }): OptionPremium {
  const bid = pos(fields.bid);
  const ask = pos(fields.ask);
  const last = pos(fields.last);
  const close = pos(fields.close);
  const mid = pos(fields.mid) ?? twoSidedMid(bid, ask);
  const evidence = {
    mid: mid, bid, ask, last, close, side,
  };

  const pick = (price: number, source: PremiumSource, reason: string, placeable: boolean): OptionPremium => {
    const decision = decideGo({
      answers: [gate({
        id: 'option_premium',
        pick: PASS,
        because: reason,
        evidence: { ...evidence, source, price },
      })],
    });
    return { price, source, reason, placeable, evidence: { ...evidence, source, price }, decision };
  };

  if (mid != null) return pick(mid, 'mid', 'two-sided mid', true);
  if (side === 'buy' && ask != null) return pick(ask, 'ask', 'ask (one-sided)', true);
  if (opts?.strict && side === 'buy') {
    const decision = decideGo({
      answers: [gate({
        id: 'option_premium',
        pick: FAIL,
        because: 'strict price: need a two-sided mid or an ask',
        evidence,
      })],
    });
    return {
      price: null,
      source: null,
      reason: 'strict price: need a two-sided mid or an ask',
      placeable: false,
      evidence,
      decision,
    };
  }
  if (side === 'sell' && bid != null) return pick(bid, 'bid', 'bid (one-sided)', true);
  if (last != null) return pick(last, 'last', 'last trade', false);
  if (close != null) return pick(close, 'close', 'prior close', false);
  const unknown = !bid && !ask && !last && !close && fields.mid == null;
  const decision = decideGo({
    answers: [gate({
      id: 'option_premium',
      pick: unknown ? UNKNOWN : FAIL,
      because: 'no mid/ask/last/close — cannot size',
      evidence,
    })],
  });
  return {
    price: null,
    source: null,
    reason: 'no mid/ask/last/close — cannot size',
    placeable: false,
    evidence,
    decision,
  };
}

/** OCC keys the contracts API and the data API may disagree on (space-padded root). */
export function occLookupKeys(symbol: string): string[] {
  const raw = String(symbol || '').toUpperCase();
  if (!raw) return [];
  const compact = raw.replace(/\s+/g, '');
  const keys = new Set<string>([raw, compact]);
  const m = /^([A-Z]+)(\d{2})(\d{2})(\d{2})([CP])(\d{8})$/.exec(compact);
  if (m) {
    const [, root, yy, mm, dd, cp, strk] = m;
    keys.add(`${root.padEnd(6, ' ')}${yy}${mm}${dd}${cp}${strk}`);
  }
  return [...keys];
}

export function lookupByOcc<T>(map: Record<string, T> | null | undefined, symbol: string): T | undefined {
  if (!map) return undefined;
  for (const k of occLookupKeys(symbol)) {
    if (map[k] != null) return map[k];
  }
  const compact = String(symbol || '').toUpperCase().replace(/\s+/g, '');
  if (!compact) return undefined;
  for (const [k, v] of Object.entries(map)) {
    if (String(k).toUpperCase().replace(/\s+/g, '') === compact) return v;
  }
  return undefined;
}

export type StrikePick<T extends { strike: number }> = T & OptionQuoteFields;

/**
 * Nearest listed strike to the moneyness target that we can *size*
 * (mid/ask/last/close). Do not abandon an ITM LEAPS that has a last/close
 * just because ATM has an ask. If nothing on the expiry is marked, return
 * the bare nearest so the caller can fail closed with a concrete OCC.
 */
export function pickNearestContract<T extends { strike: number }>(
  list: T[],
  targetStrike: number,
  fieldsOf: (c: T) => OptionQuoteFields,
  side: 'buy' | 'sell' = 'buy',
  opts?: { strict?: boolean },
): T | null {
  if (!list.length) return null;
  const scored = list.map((c) => {
    const prem = optionPremium(fieldsOf(c), side, { strict: opts?.strict === true });
    return { c, prem, dist: Math.abs(Number(c.strike) - targetStrike) };
  });
  if (opts?.strict) {
    const placeable = scored.filter((x) => x.prem.placeable && x.prem.price != null);
    if (!placeable.length) return null;
    return placeable.reduce((best, x) => (x.dist < best.dist ? x : best)).c;
  }
  const sizeable = scored.filter((x) => x.prem.price != null);
  const pool = sizeable.length ? sizeable : scored;
  return pool.reduce((best, x) => {
    if (x.dist < best.dist) return x;
    if (x.dist === best.dist && x.prem.placeable && !best.prem.placeable) return x;
    return best;
  }).c;
}

export type AssetClassHint = {
  asset_class?: string | null;
  option_type?: string | null;
  strike_target?: string | null;
  expiration?: string | null;
  _contract?: { occSymbol?: string | null } | null;
  _play?: { dte?: number | null; tag?: string | null; key?: string | null } | null;
};

/** True when the *play* is an option, even if asset_class defaulted to equity. */
export function looksLikeOptionPlay(d: AssetClassHint): boolean {
  const ac = String(d.asset_class || '').toLowerCase();
  if (ac === 'option') return true;
  const ot = String(d.option_type || '').toLowerCase();
  if (ot === 'call' || ot === 'put') return true;
  if (d._contract?.occSymbol) return true;
  if (d._play && (d._play.dte != null || d._play.tag || d._play.key)) return true;
  return false;
}

export function inferAssetClass(d: AssetClassHint): string {
  if (looksLikeOptionPlay(d)) return 'option';
  const raw = String(d.asset_class || '').toLowerCase();
  return raw || 'equity';
}

export function assignInferredAssetClass<T extends AssetClassHint>(d: T): T {
  d.asset_class = inferAssetClass(d);
  return d;
}

export function allowlistSkipReason(assetClass: string, allowed: string[]): string | null {
  const ac = (assetClass || 'equity').toLowerCase();
  if (allowed.includes(ac)) return null;
  return `'${ac}' not in allowlist [${allowed.join(',')}]`;
}

function parseMaybeJson(v: any): any {
  if (v == null) return null;
  if (typeof v === 'object') return v;
  if (typeof v === 'string') { try { return JSON.parse(v); } catch { return null; } }
  return null;
}

/**
 * Should this bot emit on the allowlist? Equity ORB (Fri 8028140) is skipped
 * on an options-only desk. Autofix DELETES leftover equity rows — it does not
 * convert them to calls or park them.
 */
export function botClassSkipReason(
  bot: { asset_class?: string | null; action?: any },
  allowed: string[],
): string | null {
  const action = parseMaybeJson(bot.action) || {};
  const ac = inferAssetClass({
    asset_class: bot.asset_class,
    option_type: action.option_type,
    strike_target: action.strike_target,
    expiration: action.expiration,
  });
  return allowlistSkipReason(ac, allowed);
}

export type DraftNotional = {
  assetClass: string;
  price: number;
  notional: number;
  unpriceableOptionBuy: boolean;
  reason: string;
};

/** Pure notional used by max_position_usd. */
export function draftNotionalUsd(draft: AssetClassHint & {
  side?: string;
  qty?: number;
  est_price?: number | null;
  limit_price?: number | null;
  /** SMCI-style: last and close are not a buy price. */
  strictPrice?: boolean;
  _contract?: { mid?: number | null; ask?: number | null; bid?: number | null; last?: number | null; close?: number | null } | null;
}): DraftNotional {
  const assetClass = inferAssetClass(draft);
  const strict = draft.strictPrice === true && assetClass === 'option' && draft.side === 'buy';
  const strictPrem = strict
    ? optionPremium({
      mid: draft._contract?.mid,
      ask: draft._contract?.ask,
      bid: draft._contract?.bid,
      last: draft._contract?.last,
      close: draft._contract?.close,
    }, 'buy', { strict: true })
    : null;
  const price = strict
    ? (strictPrem?.placeable ? Number(strictPrem.price) : 0)
    : (pos(draft.est_price) ?? pos(draft.limit_price) ?? 0);
  const qty = Number(draft.qty);
  const haveQty = Number.isFinite(qty) && qty > 0;
  const mult = assetClass === 'option' ? CONTRACT_MULT : 1;
  const raw = price > 0 && haveQty ? price * qty * mult : 0;
  const notional = Math.round(raw * 100) / 100;
  const unpriceableOptionBuy = assetClass === 'option' && draft.side === 'buy' && (strict ? !strictPrem?.placeable : !(notional > 0));
  let reason = '';
  if (unpriceableOptionBuy) {
    if (strict) reason = strictPrem?.reason || 'strict price: need a two-sided mid or an ask';
    else if (!haveQty) reason = 'option buy not priceable — qty is 0';
    else if (!(price > 0)) reason = 'option buy not priceable — no mid/ask/last/close (notional_usd: 0)';
    else reason = 'option buy not priceable — cannot size';
  }
  return { assetClass, price, notional, unpriceableOptionBuy, reason };
}

/** Attach a resolved premium onto a draft. No-op when already priced or quote missing. */
export function applyResolvedPremium<T extends {
  side?: string;
  est_price?: number;
  _contract?: { mid?: number | null; ask?: number | null; bid?: number | null; last?: number | null; close?: number | null };
  _strict_price?: boolean;
}>(draft: T, quote: OptionQuoteFields, opts?: { strict?: boolean }): OptionPremium {
  const strict = opts?.strict === true || draft._strict_price === true;
  const prem = optionPremium(quote, draft.side === 'sell' ? 'sell' : 'buy', { strict });
  if (strict && !prem.placeable) {
    draft.est_price = undefined;
    return prem;
  }
  if (!(Number(draft.est_price) > 0) && prem.price != null) draft.est_price = prem.price;
  return prem;
}
