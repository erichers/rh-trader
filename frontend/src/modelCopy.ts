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

/** Exit cadence the API sends. Used when /api/jev has not answered yet. */
export const JEV_CADENCE_FALLBACK = [
  { band: 'expiry', dte: '0 DTE, last 90 min', every: '2 min' },
  { band: 'short', dte: '0 to 3', every: '3 min' },
  { band: 'medium', dte: '4 to 14', every: '12 min' },
  { band: 'between', dte: '15 to 89', every: '60 min' },
  { band: 'leaps', dte: '90 and out', every: '3 hr' },
];

const JEV_SKIP_LABELS: Record<string, string> = {
  per_bot_off: 'scope off',
  global_off: 'global off',
  shadow: 'shadow',
  paper_only: 'paper only',
  cadence: 'still fresh',
  rth_closed: 'market closed',
  budget: 'budget spent',
  no_key: 'no key',
  error: 'error',
};

/** Desk language for a decision that was logged and not applied. */
export function jevSkipLabel(skipped: string | null | undefined): string {
  const key = String(skipped || '').trim();
  if (!key) return 'logged';
  return JEV_SKIP_LABELS[key] || key.replace(/_/g, ' ');
}

function jevFlagOn(v: unknown): boolean {
  return v === true || v === 1 || v === '1' || v === 'true';
}

/** Default off. Matches the server: only an explicit true enables a scope. */
export function jevScopeFlags(risk: unknown): { entry: boolean; exit: boolean } {
  let obj: any = risk;
  if (typeof risk === 'string') {
    try { obj = JSON.parse(risk); } catch { obj = null; }
  }
  const jev = obj && typeof obj === 'object' ? obj.jev : null;
  if (!jev || typeof jev !== 'object') return { entry: false, exit: false };
  return { entry: jevFlagOn(jev.entry), exit: jevFlagOn(jev.exit) };
}

export const JEV_EMPTY_PICK = 'No last pick yet. Either the bots are quiet, or Jev is off and the rails are flying solo.';

export function jevScopeLabel(flags: { entry?: boolean; exit?: boolean } | null | undefined): string {
  const entry = !!flags?.entry;
  const exit = !!flags?.exit;
  if (entry && exit) return 'entry + exit';
  if (entry) return 'entry on';
  if (exit) return 'exit on';
  return 'off';
}
