/**
 * Exit-lifecycle helpers — pure so the live monitor and tests agree.
 *
 * Monday paper bugs this encodes:
 *  (a) do NOT close a monitor on broker `new` / our `placed` — only a terminal fill
 *  (b) a `new` sell that sits (qty locked) is pending, then cancel+retry / escalate
 *  (c) held=0 + no exact position → orphan once; never place another sell
 *  (d) settings JSON that exploded into char keys is rewritten to clean defaults
 */

export const STUCK_NEW_MS = 90_000;
export const MAX_EXIT_ATTEMPTS = 3;
export const EXIT_POLICY_DEFAULTS = {
  holdOvernight: false,
  holdOverWeekend: false,
  closeBufferMin: 15,
} as const;

export type ExitPolicyShape = {
  holdOvernight: boolean;
  holdOverWeekend: boolean;
  closeBufferMin: number;
};

export type ExitPlacement = 'filled' | 'pending' | 'failed';

const FILLED = new Set(['filled']);
const PENDING = new Set([
  'new', 'placed', 'accepted', 'pending_new', 'accepted_for_bidding',
  'calculated', 'partially_filled', 'pending_cancel', 'pending_replace',
]);
const FAILED = new Set([
  'vetoed', 'rejected', 'canceled', 'cancelled', 'expired', 'done_for_day',
  'stopped', 'suspended', 'observe', 'observe_only', 'draft', 'staged',
]);

/** Map a broker (Alpaca) or local order status to our row status. */
export function mapBrokerOrderStatus(rawStatus: any): string {
  const s = String(rawStatus || '').toLowerCase();
  if (FILLED.has(s)) return 'filled';
  if (s === 'partially_filled') return 'partially_filled';
  if (s === 'canceled' || s === 'cancelled' || s === 'expired' || s === 'done_for_day') return 'canceled';
  if (s === 'rejected' || s === 'stopped' || s === 'suspended') return 'rejected';
  if (PENDING.has(s)) return s === 'placed' ? 'placed' : 'new';
  return s || 'placed';
}

/** After executeDraft: only a real fill may close the monitor (NVDA 203 / order 7117001). */
export function exitPlacementOutcome(res: {
  status?: string;
  fillPrice?: number | null;
  filledQty?: number | null;
  orderQty?: number | null;
}): ExitPlacement {
  const s = String(res.status || '').toLowerCase();
  if (FAILED.has(s) && s !== 'partially_filled') return 'failed';
  if (FILLED.has(s)) return 'filled';
  const fq = Number(res.filledQty);
  const oq = Number(res.orderQty);
  if (Number(res.fillPrice) > 0 && fq > 0 && oq > 0 && fq + 1e-9 >= oq) return 'filled';
  if (PENDING.has(s) || s === 'placed' || s === 'new') return 'pending';
  return 'pending';
}

export function isPendingExitStatus(status?: string): boolean {
  const s = String(status || '').toLowerCase();
  return PENDING.has(s) || s === 'placed' || s === 'new';
}

export function isTerminalFillStatus(status?: string): boolean {
  return FILLED.has(String(status || '').toLowerCase());
}

/** held=0 on this exact contract/symbol → orphan once. Do not require a second veto. */
export function heldZeroDecision(opts: {
  heldQty: number;
  exactOpenQty: number;
  pendingExit: boolean;
}): 'orphan' | 'wait' | 'keep' {
  if (opts.pendingExit) return 'wait';
  if (!(opts.heldQty === 0) && !(opts.exactOpenQty === 0)) return 'keep';
  if (opts.heldQty === 0 && opts.exactOpenQty === 0) return 'orphan';
  if (opts.heldQty === 0 && opts.exactOpenQty > 0) return 'wait'; // snapshot lag / qty locked
  return 'keep';
}

export function shouldRetryStuckNew(opts: {
  ageMs: number;
  attempts: number;
  status?: string;
}): 'wait' | 'cancel_retry' | 'escalate' {
  if (!isPendingExitStatus(opts.status)) return 'wait';
  if (opts.ageMs < STUCK_NEW_MS) return 'wait';
  if (opts.attempts >= MAX_EXIT_ATTEMPTS) return 'escalate';
  return 'cancel_retry';
}

/** Detect the "string exploded to char keys" corruption (0:'{', 1:'"', …). */
export function isCorruptedSettingsObject(raw: any, expectedKeys: string[]): boolean {
  if (raw == null) return false;
  if (typeof raw !== 'object' || Array.isArray(raw)) return true;
  const keys = Object.keys(raw);
  if (!keys.length) return false;
  const expectedHits = expectedKeys.filter((k) => Object.prototype.hasOwnProperty.call(raw, k)).length;
  if (expectedHits > 0) return false;
  const exploded = keys.every((k) => /^\d+$/.test(k) || k.length === 1);
  return exploded || keys.length > 8;
}

export function clampExitPolicy(raw: any): { policy: ExitPolicyShape; rewritten: boolean } {
  if (isCorruptedSettingsObject(raw, ['holdOvernight', 'holdOverWeekend', 'closeBufferMin'])) {
    return { policy: { ...EXIT_POLICY_DEFAULTS }, rewritten: true };
  }
  const o = raw && typeof raw === 'object' ? raw : {};
  const close = Number(o.closeBufferMin);
  const policy: ExitPolicyShape = {
    holdOvernight: o.holdOvernight === true,
    holdOverWeekend: o.holdOverWeekend === true,
    closeBufferMin: Number.isFinite(close) && close > 0 ? Math.min(60, Math.max(2, close)) : EXIT_POLICY_DEFAULTS.closeBufferMin,
  };
  return { policy, rewritten: false };
}

export function parsePendingExitOrderId(reason: string | null | undefined, column?: number | null): number | null {
  if (Number(column) > 0) return Number(column);
  const m = /\[exiting\][^\d]*#?(\d+)/i.exec(String(reason || ''));
  return m ? Number(m[1]) : null;
}

export function exitingReason(orderId: number, why: string): string {
  return `EXIT PENDING [exiting] #${orderId} ${why}`.slice(0, 250);
}

export function held0Reason(detail: string): string {
  return `held=0 [held0] ${detail}`.slice(0, 250);
}
