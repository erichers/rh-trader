/**
 * Map `action._timeframe` to an Alpaca bars timeframe.
 *
 * Default is 1Day when the field is missing. LEAPS momentum bots seed
 * `_timeframe: "15Min"` so evaluateBot must not hardcode daily bars.
 */

export type AlpacaTimeframe = '1Day' | '1Hour' | '15Min' | '5Min' | '1Min';

function compact(raw?: string | null): string {
  return String(raw || '').trim().toLowerCase().replace(/[\s_\-]/g, '');
}

/** Alpaca `timeframe=` query value used by `closesFor` / `refreshBars`. */
export function resolveAlpacaTimeframe(raw?: string | null): AlpacaTimeframe {
  const s = compact(raw);
  if (!s) return '1Day';
  if (s === '15m' || s === '15min') return '15Min';
  if (s === '5m' || s === '5min') return '5Min';
  if (s === '1h' || s === '1hour' || s === '60m' || s === '60min') return '1Hour';
  if (s === '1m' || s === '1min') return '1Min';
  if (s === '1d' || s === '1day' || s === 'day' || s === 'daily') return '1Day';
  return '1Day';
}

/** Signal-row timeframe matches the Alpaca bars the eval used. */
export function signalTimeframe(tf: AlpacaTimeframe | string): string {
  return resolveAlpacaTimeframe(tf);
}

export function botEvalTimeframe(action?: { _timeframe?: string | null } | null): AlpacaTimeframe {
  return resolveAlpacaTimeframe(action?._timeframe);
}
