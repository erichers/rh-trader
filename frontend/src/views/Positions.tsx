import { Account, Monitors, Positions } from '../api/client';
import { Card, money, num, signClass, useAsync, Sym, Live, posLast } from '../components/ui';
import { DataTable } from '../components/datatable';
import ExitPulseMark from '../components/ExitPulseMark';
import { PAPER_NEXT_STEP, PAPER_POSITIONS_EMPTY } from '../deskChrome';
import { bookPeakPct, bookPlPct, bookSizeUsd, fmtBookPct, parseOcc } from '../optionBook';
import './positions.css';

/** Dollars shown as a quantity (cash is held in units of one dollar). */
const qtyFmt = (v: number) => v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export default function PositionsView({ health }: { health?: any }) {
  const { data, loading } = useAsync<any[]>(Positions, [], 6000);
  const acct = useAsync<any>(Account, [], 15000);
  const mons = useAsync<any[]>(Monitors, [], 15000);
  const rows = data || [];
  const openMons = (mons.data || []).filter((m) => m.status === 'open' && Number(m.qty) > 0);
  const monitorFor = (p: any) => openMons.find((m) => m.occ_symbol && p.symbol === m.occ_symbol)
    || openMons.find((m) => m.symbol && p.symbol === m.symbol);

  const a = acct.data;
  const cash = Number(a?.cash);
  const hasCash = Number.isFinite(cash);
  const equity = Number(a?.equity);
  const env = a?.env || health?.env || 'alpaca_paper';
  const live = env !== 'alpaca_paper';

  // Cash is a position: it is the balance every unopened trade is still sitting in.
  const holdings = rows.reduce((s, p) => s + (Number(p.market_value) || 0), 0);
  const total = holdings + (hasCash ? cash : 0);
  const drift = Number.isFinite(equity) ? total - equity : null;
  const count = rows.length + (hasCash ? 1 : 0);

  const book = rows.map((p) => {
    const mon = Number(p.qty) > 0 ? monitorFor(p) : null;
    const occ = p.occ_symbol || mon?.occ_symbol || (String(p.asset_class || '').toLowerCase() === 'option' ? p.symbol : '');
    const parsed = parseOcc(occ);
    const entry = mon?.entry_price ?? p.avg_cost;
    const last = posLast(p) ?? mon?.last_price;
    return { p, mon, occ, parsed, entry, last, peak: mon?.peak_price };
  });

  return (
    <Card title={`Positions (${count})`} right={rows.some((p) => p.live) ? <Live /> : undefined}>
      {loading && !rows.length && !hasCash ? <div className="muted">Loading…</div> : (
        <>
          {rows.length === 0 && (
            <div className="muted" style={{ marginBottom: hasCash ? 12 : 0 }}>
              {live ? 'No open positions.' : (
                <>
                  <div>{PAPER_POSITIONS_EMPTY}</div>
                  <div>{PAPER_NEXT_STEP}</div>
                </>
              )}
            </div>
          )}
          {hasCash && (
            <div className="muted" style={{ marginBottom: 8 }}>Cash {qtyFmt(cash)} · {money(cash)}</div>
          )}
          {rows.length > 0 && (
            <DataTable
              rows={book}
              storageKey="pos-book"
              initialSort={{ key: 'pl', dir: -1 }}
              filter={book.length > 6}
              filterPlaceholder="filter positions…"
              rowKey={(r) => r.p.id || r.occ || r.p.symbol}
              cols={[
                { key: 'name', label: 'Contract', sortValue: (r) => r.parsed?.root || r.p.symbol, filterValue: (r) => `${r.p.symbol} ${r.occ} ${r.parsed?.human || ''}`, render: (r) => (
                  <span>
                    <Sym bold>{r.parsed?.root || r.p.symbol}</Sym>
                    {r.parsed ? <div className="muted" style={{ fontSize: 11 }}>{r.parsed.human}</div> : null}
                  </span>
                ) },
                { key: 'qty', label: 'Qty', align: 'right', sortValue: (r) => Number(r.p.qty), render: (r) => num(r.p.qty) },
                { key: 'size', label: 'Size $', align: 'right', sortValue: (r) => bookSizeUsd(r.p.qty, r.last, r.p.asset_class, r.occ) ?? -1, render: (r) => {
                  const n = bookSizeUsd(r.p.qty, r.last, r.p.asset_class, r.occ);
                  return n == null ? <span className="muted">—</span> : money(n);
                } },
                { key: 'entry', label: 'Entry', align: 'right', sortValue: (r) => Number(r.entry) || 0, render: (r) => money(r.entry) },
                { key: 'last', label: 'Last', align: 'right', sortValue: (r) => Number(r.last) || 0, render: (r) => r.last != null ? money(r.last) : <span className="muted">—</span> },
                { key: 'pl', label: 'P/L %', align: 'right', sortValue: (r) => bookPlPct(r.entry, r.last) ?? -1e9, render: (r) => {
                  const n = bookPlPct(r.entry, r.last);
                  return n == null ? <span className="muted">—</span> : <span className={signClass(n)}>{fmtBookPct(n)}</span>;
                } },
                { key: 'peak', label: 'Peak %', align: 'right', sortValue: (r) => bookPeakPct(r.entry, r.peak) ?? -1e9, render: (r) => {
                  const n = bookPeakPct(r.entry, r.peak);
                  return n == null ? <span className="muted">—</span> : <span className="muted">{fmtBookPct(n)}</span>;
                } },
                { key: 'pulse', label: 'Exit pulse', sortable: false, render: (r) => r.mon ? <ExitPulseMark row={r.mon} health={health} /> : <span className="muted">No exit watch</span> },
              ]}
            />
          )}
          {hasCash && (
            <div className="muted" style={{ fontSize: 11, marginTop: 10 }}>
              Holdings {money(holdings)} + cash {money(cash)} = {money(total)}
              {Number.isFinite(equity) ? ` · account equity ${money(equity)}` : ''}
              {drift != null && Math.abs(drift) >= 1 ? ' (the next broker sync reconciles the difference)' : ''}
            </div>
          )}
        </>
      )}
    </Card>
  );
}
