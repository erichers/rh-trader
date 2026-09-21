/**
 * Monday full_auto paper rails: new buys are 2–14 DTE calls only.
 *
 * Puts stay in the strategy library (observe / skip). Equity templates are
 * converted to ATM weekly calls at emit time so Donchian / ORB / RSI still
 * trade — they do not open shares. Risk vetoes any leftover put or equity
 * buy that reaches the gate.
 *
 * Sells / flatten are not this rail (deterministic swing law).
 */

import type { Mode, TradingEnv } from '../config.js';
import { ENTRY_DTE_MAX, ENTRY_DTE_MIN } from './exitpolicy.js';
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
  _play?: { dte?: number | null; tag?: string | null; key?: string | null } | null;
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
      detail: 'puts_blocked — Monday full_auto paper buys calls only (2–14 DTE)',
      convertToCall: false,
    };
  }

  if (ac === 'option' && (ot === 'call' || ot === '')) {
    return { pass: true, reason: 'ok', detail: 'call option — calls-only ok', convertToCall: false };
  }

  // Equity / ETF template: convert at emit (qty 1, drop share price). If a
  // leftover equity ticket still reaches riskCheck, veto — do not convert a
  // sized share lot into N contracts.
  return {
    pass: false,
    reason: CALLS_ONLY_REASON,
    detail: `calls_only — ${ac || 'equity'} buy blocked; convert to a 2–14 DTE call or skip`,
    convertToCall: true,
  };
}

/** Rewrite an equity (or unlabeled) buy into an ATM weekly call spec. Idempotent for calls. */
export function convertEquityDraftToCall<T extends CallsOnlyHint>(draft: T): T {
  const ot = optionTypeOf(draft);
  if (ot === 'put') return draft;
  draft.asset_class = 'option';
  draft.option_type = 'call';
  if (!draft.strike_target) draft.strike_target = 'atm';
  if (!draft.expiration) draft.expiration = 'weekly';
  // Never carry a share last-price as option premium, and never keep a 13-share lot.
  draft.est_price = undefined;
  if (!(Number(draft.qty) > 0) || Number(draft.qty) > 4) draft.qty = 1;
  const play = draft._play && typeof draft._play === 'object' ? { ...draft._play } : {};
  if (play.dte == null || !Number.isFinite(Number(play.dte))) {
    play.dte = 7;
  } else {
    const d = Number(play.dte);
    if (d < ENTRY_DTE_MIN) play.dte = ENTRY_DTE_MIN;
    if (d > ENTRY_DTE_MAX && d < 180) play.dte = ENTRY_DTE_MAX;
  }
  if (!play.tag) play.tag = 'call-7';
  if (!play.key) play.key = 'calls_only';
  draft._play = play;
  return draft;
}

/** True when an option-only allowlist would skip this bot, but Monday rails can convert it. */
export function shouldConvertEquityBot(opts: {
  classSkip: string | null;
  optionAllowed: boolean;
  mode?: string | null;
  env?: string | null;
  observeOnly?: boolean;
}): boolean {
  if (!opts.classSkip) return false;
  if (opts.observeOnly) return false;
  if (!opts.optionAllowed) return false;
  return isFullAutoPaper({ mode: opts.mode, env: opts.env });
}
