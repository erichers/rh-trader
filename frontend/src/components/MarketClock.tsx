import { useEffect, useState } from 'react';
import { Clock } from '../api/client';

const TZ = 'America/Los_Angeles';

function fmtPT(d: Date): string {
  return d.toLocaleTimeString('en-US', { timeZone: TZ, hour: 'numeric', minute: '2-digit', hour12: true }) + ' PT';
}

function countdown(target: string | null): string {
  if (!target) return '';
  const ms = new Date(target).getTime() - Date.now();
  if (ms <= 0) return 'now';
  const m = Math.floor(ms / 60000);
  const h = Math.floor(m / 60);
  const d = Math.floor(h / 24);
  if (d > 0) return `${d}d ${h % 24}h`;
  if (h > 0) return `${h}h ${m % 60}m`;
  return `${m}m`;
}

export default function MarketClock() {
  const [now, setNow] = useState(new Date());
  const [clock, setClock] = useState<any>(null);

  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 1000);
    const load = () => Clock().then(setClock).catch(() => {});
    load();
    const c = setInterval(load, 30000);
    return () => { clearInterval(t); clearInterval(c); };
  }, []);

  const open = !!clock?.is_open;
  const target = open ? clock?.next_close : clock?.next_open;
  return (
    <span className="row" style={{ gap: 8 }} title={`Market data clock (${clock?.source || '…'})`}>
      <span style={{ fontVariantNumeric: 'tabular-nums', fontWeight: 600 }}>{fmtPT(now)}</span>
      <span className={`badge ${open ? 'green' : 'gray'}`} style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
        <span className={`dot ${open ? 'green' : 'gray'}`} />
        {open ? 'OPEN' : 'CLOSED'}
      </span>
      {clock && (
        <span className="muted" style={{ fontSize: 11 }}>
          {open ? 'closes in' : 'opens in'} {countdown(target)}
        </span>
      )}
    </span>
  );
}
