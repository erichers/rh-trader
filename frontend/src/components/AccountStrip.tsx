import { useState } from 'react';
import { Account, Pnl } from '../api/client';
import { money, signClass, useAsync } from './ui';
import { Sparkline } from './svgcharts';
import './accountstrip.css';

// The strip's windows map 1:1 onto the P/L windows the backend already computes,
// so the number and the chart always come from the same slice of real equity.
// Alpaca's portfolio history reaches back one year, which is what "1Y" means here;
// an account with a shorter history shows its true start date next to the figure.
const WINDOWS: { key: string; label: string }[] = [
  { key: 'day', label: '1D' },
  { key: 'week', label: '1W' },
  { key: 'month', label: '1M' },
  { key: 'd90', label: '3M' },
  { key: 'ytd', label: 'YTD' },
  { key: 'all', label: '1Y' },
];

const STORE_KEY = 'rh.accountStrip.window';

function loadWindow(): string {
  try {
    const v = localStorage.getItem(STORE_KEY);
    if (v && WINDOWS.some((w) => w.key === v)) return v;
  } catch { /* private mode / storage disabled — fall back to the default */ }
  return 'day';
}

// Month and day, plus the year whenever the baseline is not from this year — a 1Y or
// YTD window that reads "since Aug 27" without a year invites the wrong reading.
const shortDate = (sec: number) => {
  const d = new Date(sec * 1000);
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return d.toLocaleDateString('en-US', {
    timeZone: 'America/Los_Angeles', month: 'short', day: 'numeric', ...(sameYear ? {} : { year: 'numeric' }),
  });
};

/** Always-visible account bar: cash, buying power, equity, and the P/L for the
 *  selected window as dollars and percent, over a compact equity sparkline for the
 *  same window. Polls the account and P/L endpoints every 15s. Read-only — it never
 *  posts anything, so it is safe on every route in both environments. */
export default function AccountStrip({ health }: { health?: any }) {
  const [winKey, setWinKey] = useState<string>(loadWindow);
  const acct = useAsync<any>(Account, [], 15000);
  const pnl = useAsync<any>(Pnl, [], 15000);

  const pick = (k: string) => {
    setWinKey(k);
    try { localStorage.setItem(STORE_KEY, k); } catch { /* storage disabled — selection is session-only */ }
  };

  const env = acct.data?.env || health?.env || 'alpaca_paper';
  const live = env !== 'alpaca_paper';
  const a = acct.data;
  const hasAccount = !!a && a.equity != null;
  // A stale row is worse than no row: an unsynced balance shown as $0.00 reads as "the
  // account is empty" instead of "we have not heard from the broker in a while".
  const updatedMs = hasAccount && a.updated_at ? new Date(a.updated_at).getTime() : NaN;
  const ageMs = Number.isFinite(updatedMs) ? Date.now() - updatedMs : NaN;
  const allZero = hasAccount && Number(a.cash) === 0 && Number(a.equity) === 0 && Number(a.buying_power) === 0;
  const stale = hasAccount && Number.isFinite(ageMs) && (ageMs > 24 * 60 * 60 * 1000
    || (live && allZero && ageMs > 60 * 60 * 1000));

  const p = pnl.data;
  const available = p?.source && p.source !== 'unavailable' && Array.isArray(p?.series) && p.series.length > 0;
  const win = available ? p.windows?.[winKey] : null;
  const label = WINDOWS.find((w) => w.key === winKey)?.label || '';
  // 1D is drawn from today's 5-minute curve when the broker publishes one (it starts at
  // the prior close, the same baseline the day figure uses); every other window slices
  // the daily equity series at that window's own `from`.
  const intraday: { t: number; equity: number }[] = Array.isArray(p?.intraday) ? p.intraday : [];
  const slice: { t: number; equity: number }[] = !win || !available ? []
    : (winKey === 'day' && intraday.length >= 2)
      ? intraday
      : p.series.filter((pt: any) => pt.t >= win.from);

  const plText = win ? `${win.pl >= 0 ? '+' : ''}${money(win.pl)}` : '—';
  const pctText = win ? `${win.pct >= 0 ? '+' : ''}${win.pct.toFixed(2)}%` : '';

  const chartNote = !available
    ? (pnl.err ? 'P/L history is unavailable right now.' : pnl.loading ? 'Loading account history…' : (p?.reason || 'No recorded equity history for this account yet.'))
    : !win
      ? `No recorded baseline for ${label} yet.`
      : slice.length < 2
        ? `Only one recorded equity point since ${shortDate(win.from)}.`
        : null;

  return (
    <div className="acct-strip">
      <span className={`env-badge acct-badge ${live ? 'live' : 'paper'}`} title="Account these balances belong to">
        <span className="dot" />
        <span className="acct-env-full">{live ? 'LIVE · Robinhood' : 'Paper · Alpaca'}</span>
        <span className="acct-env-short">{live ? 'LIVE' : 'Paper'}</span>
      </span>

      <div className="acct-seg seg" role="group" aria-label="Profit and loss time window">
        {WINDOWS.map((w) => (
          <button key={w.key} type="button" className={winKey === w.key ? 'on' : ''}
            aria-pressed={winKey === w.key} onClick={() => pick(w.key)}>
            {w.label}
          </button>
        ))}
      </div>

      <div className="acct-figs">
        <div className="acct-fig">
          <span className="acct-k">Cash</span>
          <span className="acct-v">{stale ? <span className="muted">not synced</span> : hasAccount ? money(a.cash) : '—'}</span>
        </div>
        <div className="acct-fig">
          <span className="acct-k">Available to trade</span>
          <span className="acct-v">{stale ? <span className="muted">not synced</span> : hasAccount ? money(a.buying_power) : '—'}</span>
        </div>
        <div className="acct-fig">
          <span className="acct-k">Equity</span>
          <span className="acct-v">{stale ? <span className="muted">not synced</span> : hasAccount ? money(a.equity) : '—'}</span>
        </div>
        <div className="acct-fig">
          <span className="acct-k">
            {label} P/L{win ? (winKey === 'day' ? ' · vs prior close' : ` · since ${shortDate(win.from)}`) : ''}{win?.partial ? ' (partial)' : ''}
          </span>
          <span className={`acct-v ${win ? signClass(win.pl) : 'muted'}`}>
            {plText}
            {pctText && <span className="acct-pct">{pctText}</span>}
          </span>
        </div>
      </div>
      {stale && <span className="acct-note muted" style={{ fontSize: 11 }}>Sync to refresh</span>}

      <div className="acct-chart">
        {chartNote ? <span className="acct-note">{chartNote}</span> : <Sparkline points={slice} height={48} up={win!.pl >= 0} />}
      </div>
    </div>
  );
}
