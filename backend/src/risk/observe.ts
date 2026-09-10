/**
 * Observe-only stubs (Mean-Revert Watch, Quiet Range Scout, Vol-Regime MR, and any
 * bot tagged `_observe_only`) must never act like trading bots.
 *
 * Mode `observe` on a normal bot still writes an audit draft. That is NOT this gate.
 * This flag is a hard block: no place, no stage, no draft-as-trade, no veto row.
 * Enabled=1 must not weaken it — Fox had to disable the stubs because the old
 * engine path still called executeDraft.
 */

export const OBSERVE_STUB_NAMES = [
  'Mean-Revert Watch',
  'Quiet Range Scout',
  'Vol-Regime MR',
] as const;

export const OBSERVE_STUB_KEYS = [
  'mean-revert-watch',
  'quiet-range-scout',
  'vol-regime-mr',
] as const;

const STUB_NAME_SET = new Set<string>(OBSERVE_STUB_NAMES.map((n) => n.toLowerCase()));
const STUB_KEY_SET = new Set<string>(OBSERVE_STUB_KEYS);

export function parseJsonish(v: any): any {
  if (v == null) return null;
  if (typeof v === 'object') return v;
  if (typeof v === 'string') {
    try { return JSON.parse(v); } catch { return null; }
  }
  return null;
}

function truthyFlag(v: any): boolean {
  return v === true || v === 1 || v === '1' || v === 'true';
}

function strategyKeyOf(action: any, rules: any, risk: any): string {
  const k = action?._strategy || action?.strategy || rules?._strategy || risk?._strategy;
  return typeof k === 'string' ? k.trim().toLowerCase() : '';
}

/** True when this bot/config is a watch stub, regardless of enabled or mode. */
export function isObserveOnlyBot(bot: {
  name?: any;
  action?: any;
  rules?: any;
  risk?: any;
  mode?: any;
  enabled?: any;
} | null | undefined): boolean {
  if (!bot) return false;
  const action = parseJsonish(bot.action) ?? bot.action;
  const rules = parseJsonish(bot.rules) ?? bot.rules;
  const risk = parseJsonish(bot.risk) ?? bot.risk;
  if (truthyFlag(action?._observe_only) || truthyFlag(action?.observe_only)) return true;
  if (truthyFlag(rules?._observe_only) || truthyFlag(rules?.observe_only)) return true;
  if (truthyFlag(risk?._observe_only) || truthyFlag(risk?.observe_only)) return true;
  const key = strategyKeyOf(action, rules, risk);
  if (key && STUB_KEY_SET.has(key)) return true;
  const name = String(bot.name || '').trim().toLowerCase();
  if (name && STUB_NAME_SET.has(name)) return true;
  return false;
}

export type ObserveGate = {
  blocked: boolean;
  createOrderRow: boolean;
  status: 'observe_only' | null;
  reason: string;
};

/**
 * Hard gate used by executeDraft. Buys from observe-only bots never create an
 * order row (draft / staged / placed / vetoed). Close-only sells still pass so
 * leftover paper inventory can flatten.
 */
export function observeOnlyGate(opts: {
  observeOnly: boolean;
  side: 'buy' | 'sell' | string;
}): ObserveGate {
  if (!opts.observeOnly) {
    return { blocked: false, createOrderRow: true, status: null, reason: '' };
  }
  if (String(opts.side).toLowerCase() === 'sell') {
    return { blocked: false, createOrderRow: true, status: null, reason: 'observe-only bot — close-only sell allowed' };
  }
  return {
    blocked: true,
    createOrderRow: false,
    status: 'observe_only',
    reason: 'observe-only stub — no order created (place/stage/draft/veto all blocked)',
  };
}

export function observeOnlySkipWhy(signalWhy: string): string {
  const base = (signalWhy || '').trim();
  const note = 'Observe-only stub — logged the signal; no order created.';
  return base ? `${base} ${note}` : note;
}

/** Chokepoint helper: draft flag OR loaded bot row. Used by executeDraft and tests. */
export function execObserveBlock(
  draft: { side?: string; _observe_only?: any },
  bot?: { name?: any; action?: any; rules?: any; risk?: any; mode?: any; enabled?: any } | null,
): ObserveGate {
  const flagged = draft?._observe_only === true || draft?._observe_only === 1 || draft?._observe_only === 'true';
  return observeOnlyGate({
    observeOnly: flagged || isObserveOnlyBot(bot),
    side: String(draft?.side || 'buy'),
  });
}
