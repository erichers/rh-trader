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
