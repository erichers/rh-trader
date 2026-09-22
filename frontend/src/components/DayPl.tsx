import { Pnl } from '../api/client';
import { money, signClass, useAsync } from './ui';

/** Day P/L in dollars and percent. This number uses P&L color. The health strip does not. */
export default function DayPl() {
  const pnl = useAsync<any>(Pnl, [], 15000);
  const win = pnl.data?.source !== 'unavailable' ? pnl.data?.windows?.day : null;
  if (!win || !Number.isFinite(Number(win.pl))) {
    return <span className="day-pl muted" title="Day P/L versus prior close">Day —</span>;
  }
  const pl = Number(win.pl);
  const pct = Number(win.pct);
  const pctText = Number.isFinite(pct) ? `${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%` : '';
  return (
    <span className={`day-pl ${signClass(pl)}`} title="Day P/L versus prior close">
      {pl >= 0 ? '+' : ''}{money(pl)}
      {pctText && <span className="day-pl-pct">{pctText}</span>}
    </span>
  );
}
