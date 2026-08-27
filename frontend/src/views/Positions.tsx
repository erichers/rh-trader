import { Account, Positions } from '../api/client';
import { Card, money, num, signClass, useAsync, Sym, Live, posLast } from '../components/ui';
import './positions.css';

/** Dollars shown as a quantity (cash is held in units of one dollar). */
const qtyFmt = (v: number) => v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export default function PositionsView({ health }: { health?: any }) {
  const { data, loading } = useAsync<any[]>(Positions, [], 6000);
  const acct = useAsync<any>(Account, [], 15000);
  const rows = data || [];

  const a = acct.data;
  const cash = Number(a?.cash);
  const hasCash = Number.isFinite(cash);
  const equity = Number(a?.equity);
  const env = a?.env || health?.env || 'alpaca_paper';
  const live = env !== 'alpaca_paper';
  const connected = health?.rh?.status === 'connected';

  // Cash is a position: it is the balance every unopened trade is still sitting in.
  const holdings = rows.reduce((s, p) => s + (Number(p.market_value) || 0), 0);
  const total = holdings + (hasCash ? cash : 0);
  const drift = Number.isFinite(equity) ? total - equity : null;
  const count = rows.length + (hasCash ? 1 : 0);

  // Honest, environment-aware copy. The connect-and-sync hint only makes sense on the
  // Robinhood account, and only while it is not connected.
  const emptyNote = rows.length > 0 ? null
    : live
      ? (connected
        ? `No open positions in the Robinhood account.${hasCash ? ` Cash: ${money(cash)}.` : ''}`
        : 'No positions. Connect Robinhood and Sync to pull your agentic account holdings.')
      : `No open positions in the paper account.${hasCash ? ` Cash: ${money(cash)}.` : ''}`;

  return (
    <Card title={`Positions (${count})`} right={rows.some((p) => p.live) ? <Live /> : undefined}>
      {loading && !rows.length && !hasCash ? <div className="muted">Loading…</div> : (
        <>
          {emptyNote && <div className="muted" style={{ marginBottom: hasCash ? 12 : 0 }}>{emptyNote}</div>}
          {(hasCash || rows.length > 0) && (
            <table className="pos-table">
              <thead>
                <tr><th>Symbol</th><th>Class</th><th>Qty</th><th>Avg Cost</th><th>Current</th><th>Market Value</th><th>Unrealized P/L</th></tr>
              </thead>
              <tbody>
                {hasCash && (
                  <tr>
                    <td style={{ fontWeight: 700 }}>Cash</td>
                    <td><span className="pill">cash</span></td>
                    <td>{qtyFmt(cash)}</td>
                    <td className="muted">—</td>
                    <td>{money(1)}</td>
                    <td>{money(cash)}</td>
                    <td className="muted">—</td>
                  </tr>
                )}
                {rows.map((p) => {
                  const last = posLast(p);
                  return (
                  <tr key={p.id}>
                    <td><Sym bold>{p.symbol}</Sym></td>
                    <td><span className="pill">{p.asset_class}</span></td>
                    <td>{num(p.qty)}</td>
                    <td>{money(p.avg_cost)}</td>
                    <td>{last != null ? money(last) : '—'}</td>
                    <td>{money(p.market_value)}</td>
                    <td className={signClass(p.unrealized_pl)}>{money(p.unrealized_pl)}</td>
                  </tr>
                  );
                })}
              </tbody>
            </table>
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
