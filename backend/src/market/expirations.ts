/** The trading date `dte` trading days ahead (YYYY-MM-DD). resolveContract snaps this to
 *  the nearest listed expiration on/after it (QQQ/SPY etc. list daily expiries).
 *  Lives here (not quickbot.ts or bots/engine.ts) so both can import it without a cycle. */
export function dteToExpiration(dte: number): string {
  const d = new Date();
  let added = 0;
  while (added < dte) { d.setUTCDate(d.getUTCDate() + 1); const wd = d.getUTCDay(); if (wd !== 0 && wd !== 6) added++; }
  return d.toISOString().slice(0, 10);
}
