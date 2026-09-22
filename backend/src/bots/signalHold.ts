/**
 * Fail-closed holds for paper promote / demote.
 * Wait-for-signal and `_ai_boom` stay observe and disabled until a person
 * arms them with a written reason. 0-DTE (including bot 84) is a demote
 * candidate and is never auto-promoted. Neither path turns Jev exit on.
 */

export const ARM_REASON_MIN = 8;
export const ZERO_DTE_BOT_ID = 84;

function parse(v: unknown): Record<string, any> {
  if (v == null) return {};
  if (typeof v === 'object') return v as Record<string, any>;
  if (typeof v !== 'string') return {};
  try {
    const o = JSON.parse(v);
    return o && typeof o === 'object' ? o : {};
  } catch {
    return {};
  }
}

export function isSignalHold(blob: unknown): boolean {
  const o = parse(blob);
  return o._ai_boom === true || o._wait_for_signal === true || o._fox === 'wait';
}

export function isHumanArmed(blob: unknown): boolean {
  const o = parse(blob);
  const reason = typeof o._arm_reason === 'string' ? o._arm_reason.trim() : '';
  return o._human_armed === true && reason.length >= ARM_REASON_MIN;
}

function dteIsZero(d: unknown): boolean {
  if (d == null || d === '') return false;
  const n = Number(d);
  return Number.isFinite(n) && n === 0;
}

/** House skip. Bot 84, an explicit 0 DTE, or a 0-DTE name. 1 DTE allowlist is not this. */
export function isZeroDteCandidate(bot: { id?: unknown; name?: unknown; action?: unknown; risk?: unknown } | null | undefined): boolean {
  if (!bot) return false;
  if (Number(bot.id) === ZERO_DTE_BOT_ID) return true;
  const action = parse(bot.action);
  const risk = parse(bot.risk);
  const play = action._play && typeof action._play === 'object' ? action._play : {};
  if ([action._dte, action.dte, play.dte, risk._dte].some(dteIsZero)) return true;
  const exp = String(action.expiration || risk.expiration || '').toLowerCase();
  if (exp === '0dte' || exp === '0-dte') return true;
  return /0\s*-?\s*dte/i.test(String(bot.name || ''));
}

export type HoldItem = {
  key: string;
  label: string;
  pass: boolean;
  critical: boolean;
  detail: string;
};

export function holdChecklistItems(bot: { id?: unknown; name?: unknown; action?: unknown; risk?: unknown }): HoldItem[] {
  const items: HoldItem[] = [];
  if (isSignalHold(bot.action) || isSignalHold(bot.risk)) {
    items.push({
      key: 'wait_for_signal',
      label: 'Wait-for-signal / AI boom stays off until a person arms it',
      critical: true,
      pass: false,
      detail: 'Fail-closed. Rank, autofix, and paper arm will not lift this bot to full auto or enable it. Force needs a written reason and still does not turn trading on.',
    });
  }
  if (isZeroDteCandidate(bot)) {
    items.push({
      key: 'zero_dte',
      label: '0-DTE is a demote candidate',
      critical: true,
      pass: false,
      detail: 'House policy skips 0-DTE. A fill does not clear that. Do not auto-promote. Bot 84 is in this set.',
    });
  }
  return items;
}

export type PromoteHold =
  | { kind: 'none' }
  | { kind: 'blocked'; code: 'wait_for_signal' | 'zero_dte'; detail: string }
  | { kind: 'arm_stamp'; detail: string };

/** Checklist promote. 0-DTE never promotes. Signal hold stamps an arm only with force plus a reason, and still does not enable trading. */
export function promoteHoldDecision(
  bot: { id?: unknown; name?: unknown; action?: unknown; risk?: unknown },
  opts: { force?: boolean; reason?: string } = {},
): PromoteHold {
  if (isZeroDteCandidate(bot)) {
    return {
      kind: 'blocked',
      code: 'zero_dte',
      detail: '0-DTE house skip. Demote candidate. Force does not auto-promote.',
    };
  }
  if (!isSignalHold(bot.action) && !isSignalHold(bot.risk)) return { kind: 'none' };
  const reason = String(opts.reason || '').trim();
  if (opts.force && reason.length >= ARM_REASON_MIN) {
    return { kind: 'arm_stamp', detail: reason };
  }
  return {
    kind: 'blocked',
    code: 'wait_for_signal',
    detail: 'Wait-for-signal stays observe and disabled. Force needs a written reason and still does not enable trading.',
  };
}
