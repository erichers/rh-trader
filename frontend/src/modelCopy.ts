/** User-facing Jev / Muse lines. No em dashes. */

export function museTuneText(tune: { name?: string | null; botId?: number | null; missingBot?: boolean } | null | undefined): string {
  if (!tune) return '';
  if (tune.missingBot || tune.botId == null) {
    if (!tune.missingBot && tune.botId == null && !tune.name) return '';
    return 'last tune: bot missing';
  }
  return `last tune ${tune.name || `bot #${tune.botId}`}`;
}

export function jevLastText(last: {
  pick?: string | null;
  symbol?: string | null;
  bot?: string | null;
  because?: string | null;
} | null | undefined): string {
  if (!last || (!last.pick && !last.symbol && !last.bot && !last.because)) return '';
  const pick = last.pick || 'no pick';
  const sym = last.symbol || 'symbol missing';
  const bot = last.bot || 'bot missing';
  const because = last.because ? ` Because: ${last.because}` : '';
  return `${pick} for ${sym} by ${bot}.${because}`;
}

export function jevLastShort(last: { pick?: string | null; symbol?: string | null; bot?: string | null } | null | undefined): string {
  if (!last?.pick) return '';
  const sym = last.symbol ? ` ${last.symbol}` : '';
  const bot = last.bot ? ` by ${last.bot}` : '';
  return `last ${last.pick}${sym}${bot}`;
}
