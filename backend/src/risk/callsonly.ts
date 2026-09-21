/**
 * Monday full_auto paper rails: new buys are long calls.
 *
 * Non-LEAPS option entries stay in the 2–14 DTE window. Long-call LEAPS
 * (label / `expiration: 'leaps'` / ≥180 DTE) remain full_auto-eligible —
 * far expiration is intentional and must not be parked or vetoed here.
 *
 * Puts stay in the strategy library (observe / skip). Equity / ETF buys are
 * refused — never converted to calls and never parked. Autofix DELETES leftover
 * equity bot rows. Covered-call selling is not this file (naked write stays
 * blocked in the risk engine).
 *
 * Sells / flatten are not this rail (deterministic swing law).
 */

import type { Mode, TradingEnv } from '../config.js';
import { isLeapsTrade } from './dte.js';
import { inferAssetClass } from './optionPrice.js';

export const CALLS_ONLY_REASON = 'calls_only';
export const PUTS_BLOCKED_REASON = 'puts_blocked';

export type CallsOnlyHint = {
  side?: string;
  asset_class?: string | null;
  option_type?: string | null;
  strike_target?: string | null;
  expiration?: string | null;
  qty?: number;
  est_price?: number | null;
  _contract?: { type?: string | null; occSymbol?: string | null } | null;
  _play?: { dte?: number | null; tag?: string | null; key?: string | null; name?: string | null } | null;
  name?: string | null;
};

export type CallsOnlyOpts = {
  mode?: Mode | string | null;
  env?: TradingEnv | string | null;
  live?: boolean;
};

export type CallsOnlyVerdict = {
  pass: boolean;
  reason: 'ok' | typeof CALLS_ONLY_REASON | typeof PUTS_BLOCKED_REASON;
  detail: string;
  /** Engine should rewrite this draft to a 2–14 DTE call BEFORE sizing. */
  convertToCall: boolean;
};

export function isFullAutoPaper(opts: CallsOnlyOpts = {}): boolean {
  const mode = String(opts.mode || '');
  const env = String(opts.env || '');
  if (opts.live) return false;
  if (env && env !== 'alpaca_paper') return false;
  return mode === 'full_auto';
}

function optionTypeOf(d: CallsOnlyHint): 'call' | 'put' | '' {
  const ot = String(d.option_type || d._contract?.type || '').toLowerCase();
  if (ot === 'put' || ot === 'call') return ot;
  const tag = String(d._play?.tag || d._play?.key || '').toLowerCase();
  if (/(^|[^a-z])put([^a-z]|$)/.test(tag)) return 'put';
  if (/(^|[^a-z])call([^a-z]|$)/.test(tag)) return 'call';
  return '';
}

/**
 * Pure buy gate. Sells always pass. Non-full_auto / non-paper always pass
 * (cautious/observe/auto keep their existing behaviour).
 */
export function callsOnlyBuyCheck(draft: CallsOnlyHint, opts: CallsOnlyOpts = {}): CallsOnlyVerdict {
  if (String(draft.side || 'buy').toLowerCase() !== 'buy') {
    return { pass: true, reason: 'ok', detail: 'sell/exit — calls-only does not bind', convertToCall: false };
  }
  if (!isFullAutoPaper(opts)) {
    return { pass: true, reason: 'ok', detail: 'calls-only binds full_auto paper buys only', convertToCall: false };
  }

  const ac = inferAssetClass(draft);
  const ot = optionTypeOf(draft);

  if (ot === 'put') {
    return {
      pass: false,
      reason: PUTS_BLOCKED_REASON,
      detail: 'puts_blocked — Monday full_auto paper buys long calls only (LEAPS ok; puts blocked)',
      convertToCall: false,
    };
  }

  if (ac === 'option' && (ot === 'call' || ot === '')) {
    const leaps = isLeapsTrade({
      expiration: draft.expiration,
      dte: draft._play?.dte,
      name: draft.name || draft._play?.name,
      key: draft._play?.key || draft._play?.tag,
    });
    return {
      pass: true,
      reason: 'ok',
      detail: leaps
        ? 'long-call LEAPS — full_auto eligible (2–14 DTE window does not apply)'
        : 'call option — calls-only ok (2–14 DTE unless privileged 0–1)',
      convertToCall: false,
    };
  }

  // Equity / ETF: refuse. Do not convert a share lot into contracts.
  return {
    pass: false,
    reason: CALLS_ONLY_REASON,
    detail: `calls_only — ${ac || 'equity'} buy refused (options-only desk; do not convert/park)`,
    convertToCall: false,
  };
}

/** Legacy helper. Equity drafts are left unchanged — never rewritten into calls.
 *  Already-option / LEAPS drafts stay as-is (idempotent). */
export function convertEquityDraftToCall<T extends CallsOnlyHint>(draft: T): T {
  return draft;
}

/** Standing law: never convert leftover equity bots into calls. Autofix deletes them. */
export function shouldConvertEquityBot(_opts: {
  classSkip: string | null;
  optionAllowed: boolean;
  mode?: string | null;
  env?: string | null;
  observeOnly?: boolean;
}): boolean {
  return false;
}
