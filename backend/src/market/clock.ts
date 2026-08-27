import { alpacaPaper, alpacaConfigured } from '../brokers/alpaca.js';

export type MarketClock = {
  is_open: boolean;
  next_open: string | null;
  next_close: string | null;
  timestamp: string;
  source: 'alpaca' | 'fallback';
};

let cache: { at: number; data: MarketClock } | null = null;

/** US equity market clock (Alpaca, holiday-aware). Cached ~20s. */
export async function getClock(): Promise<MarketClock> {
  if (cache && Date.now() - cache.at < 20_000) return cache.data;
  if (alpacaConfigured()) {
    try {
      const c = await alpacaPaper.clock();
      const data: MarketClock = {
        is_open: !!c.is_open,
        next_open: c.next_open ?? null,
        next_close: c.next_close ?? null,
        timestamp: c.timestamp ?? new Date().toISOString(),
        source: 'alpaca',
      };
      cache = { at: Date.now(), data };
      return data;
    } catch {
      /* fall through */
    }
  }
  return fallbackClock();
}

/** Rough RTH check (9:30–16:00 ET, Mon–Fri) when Alpaca is unavailable. */
function fallbackClock(): MarketClock {
  const now = new Date();
  const et = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const day = et.getDay();
  const mins = et.getHours() * 60 + et.getMinutes();
  const open = day >= 1 && day <= 5 && mins >= 570 && mins < 960;
  return {
    is_open: open,
    next_open: null,
    next_close: null,
    timestamp: now.toISOString(),
    source: 'fallback',
  };
}

export async function isMarketOpen(): Promise<boolean> {
  return (await getClock()).is_open;
}

/** Today's date in US/Eastern (YYYY-MM-DD) — the trading calendar's own day. */
export function etDate(at: Date = new Date()): string {
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(at);
  const g = (t: string) => p.find((x) => x.type === t)?.value ?? '';
  return `${g('year')}-${g('month')}-${g('day')}`;
}

/** Minutes past ET midnight right now (so "after 16:30 ET" is a real check, not a UTC guess). */
export function etMinutes(at: Date = new Date()): number {
  const p = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(at);
  const g = (t: string) => Number(p.find((x) => x.type === t)?.value ?? 0);
  return g('hour') * 60 + g('minute');
}

/** ET weekday, 0 = Sunday. */
export function etDayOfWeek(at: Date = new Date()): number {
  const wd = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'short' }).format(at);
  return ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(wd);
}

const calendarCache = new Map<string, boolean>();

/** Was the US equity market open on `date` (default today)? Holiday-aware via Alpaca's
 *  calendar endpoint (an empty response = not a session day); falls back to Mon-Fri when
 *  Alpaca is unavailable, and caches one boolean per date. */
export async function marketWasOpenOn(date: string = etDate()): Promise<boolean> {
  const cached = calendarCache.get(date);
  if (cached !== undefined) return cached;
  let open = /^\d{4}-\d{2}-\d{2}$/.test(date) ? ![0, 6].includes(new Date(`${date}T12:00:00Z`).getUTCDay()) : false;
  if (alpacaConfigured()) {
    try {
      const rows = await alpacaPaper.calendar(date, date);
      open = Array.isArray(rows) && rows.some((r: any) => String(r?.date).slice(0, 10) === date);
      calendarCache.set(date, open); // only an authoritative answer is cached
      return open;
    } catch { /* fall through to the weekday heuristic (not cached — retry next tick) */ }
  }
  return open;
}
