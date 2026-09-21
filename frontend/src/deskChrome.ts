/**
 * Paper-desk chrome. Connect Robinhood is a live-account action.
 * On Alpaca paper it stays hidden. Going live is still a separate
 * top-bar switch plus confirm:true on the API.
 */

export function showRobinhoodConnect(env: string | null | undefined, live?: boolean | null): boolean {
  if (live === true) return true;
  if (live === false) return false;
  return String(env || '') === 'robinhood_live';
}

export const PAPER_POSITIONS_EMPTY = 'No open paper positions.';
export const PAPER_NEXT_STEP = 'Enable a bot or Sync Alpaca.';

export const KILL_ENGAGE_CONFIRM = 'Engage the kill switch? New buys stop. Exits stay on.';

/** Engage asks. Release is one click. */
export function killEngageNeedsConfirm(engaged: boolean): boolean {
  return !engaged;
}

export function deleteBotConfirm(name: string): string {
  return `Delete bot ${name}? This cannot undo.`;
}

export const JEV_STALE_MS = 4 * 60 * 60 * 1000;

/** True when the last Jev pick is older than 4 hours. A missing pick is not stale. */
export function jevChipStale(lastAt: string | null | undefined, now = Date.now()): boolean {
  if (!lastAt) return false;
  const t = Date.parse(lastAt);
  if (!Number.isFinite(t)) return false;
  return now - t > JEV_STALE_MS;
}

/** Promote-to-live stays closed on the paper desk. */
export function promoteLiveOpen(env: string | null | undefined, live?: boolean | null): boolean {
  if (live === true) return true;
  return String(env || '') === 'robinhood_live';
}
