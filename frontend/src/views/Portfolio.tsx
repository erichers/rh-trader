import { PortfolioRisk } from '../api/client';
import { Card, money, num, pct, signClass, Badge, Sym, Info, Live, useAsync } from '../components/ui';
import { DataTable, type Column } from '../components/datatable';
import { Icon } from '../components/icons';

// Portfolio-level risk: aggregate delta-dollar exposure, concentration, a correlation heatmap of
// held underlyings, a redundancy scan, and first-order stress — all from REAL open positions.

function corrColor(c: number): string {
  // green for diversifying (negative), red for correlated (positive), faded near 0.
  const a = Math.min(1, Math.abs(c));
  if (c >= 0) return `rgba(239,68,68,${0.12 + a * 0.5})`;
  return `rgba(34,197,94,${0.12 + a * 0.5})`;
}

function Stat({ label, value, sub, kind }: { label: string; value: React.ReactNode; sub?: React.ReactNode; kind?: string }) {
  return (
    <div className="card" style={{ flex: 1, minWidth: 150 }}>
      <div className="muted" style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.4 }}>{label}</div>
      <div className={`big ${kind || ''}`} style={{ fontSize: 22, fontWeight: 700, marginTop: 2 }}>{value}</div>
      {sub != null && <div className="muted" style={{ fontSize: 11 }}>{sub}</div>}
    </div>
  );
}

export default function Portfolio() {
  const { data, err, loading } = useAsync<any>(PortfolioRisk, [], 15000);

  if (loading && !data) return <Card title="Portfolio Risk"><div className="muted">Computing exposure…</div></Card>;
  if (err) return <Card title="Portfolio Risk"><div className="red">{err}</div></Card>;
  const d = data || {};
  const t = d.totals || {};
  const uls: any[] = d.underlyings || [];
  const corr: any[] = d.correlation || [];
  const syms = Array.from(new Set(corr.flatMap((c: any) => [c.a, c.b])));
  const corrMap: Record<string, number> = {};
  for (const c of corr) { corrMap[`${c.a}|${c.b}`] = c.corr; corrMap[`${c.b}|${c.a}`] = c.corr; }

  const ulCols: Column<any>[] = [
    { key: 'underlying', label: 'Underlying', render: (r) => <Sym bold>{r.underlying}</Sym> },
    { key: 'spot', label: 'Spot', align: 'right', render: (r) => money(r.spot) },
    { key: 'delta_dollars', label: 'Δ-Dollars', align: 'right', sortValue: (r) => Math.abs(r.delta_dollars), render: (r) => <span className={signClass(r.delta_dollars)}>{money(r.delta_dollars)}</span> },
    { key: 'pct_of_equity', label: '% Equity', align: 'right', render: (r) => r.pct_of_equity != null ? `${r.pct_of_equity}%` : '—' },
    { key: 'pct_of_gross', label: 'Concentration', align: 'right', sortValue: (r) => r.pct_of_gross || 0, render: (r) => (
      <div className="row" style={{ gap: 6, justifyContent: 'flex-end' }}>
        <div className="progress" style={{ width: 70 }}><div className="progress-fill blue" style={{ width: `${Math.min(100, r.pct_of_gross || 0)}%` }} /></div>
        <span style={{ width: 38, textAlign: 'right' }}>{r.pct_of_gross != null ? `${r.pct_of_gross}%` : '—'}</span>
      </div>
    ) },
    { key: 'positions', label: 'Legs', align: 'right', render: (r) => `${r.positions}${r.options ? ` · ${r.options} opt` : ''}` },
  ];

  const posCols: Column<any>[] = [
    { key: 'symbol', label: 'Symbol', render: (r) => <Sym>{r.symbol}</Sym> },
    { key: 'kind', label: 'Kind', render: (r) => <Badge kind={r.kind.includes('option') ? 'amber' : 'blue'}>{r.kind}</Badge> },
    { key: 'qty', label: 'Qty', align: 'right' },
    { key: 'market_value', label: 'Value', align: 'right', render: (r) => money(r.market_value) },
    { key: 'delta', label: 'Δ', align: 'right', render: (r) => num(r.delta, 3) },
    { key: 'delta_dollars', label: 'Δ-Dollars', align: 'right', sortValue: (r) => Math.abs(r.delta_dollars), render: (r) => <span className={signClass(r.delta_dollars)}>{money(r.delta_dollars)}</span> },
  ];

  return (
    <div className="stack" style={{ gap: 14 }}>
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
        <h2 style={{ margin: 0 }}>Portfolio Risk <Info text="Delta-dollars translate each option into its share-equivalent exposure via Black–Scholes delta (real spot + realized vol). Correlations are 90-day daily-return Pearson on real Alpaca bars. Stress is first-order (delta only)." /></h2>
        <Live />
      </div>

      <div className="row" style={{ gap: 10, flexWrap: 'wrap' }}>
        <Stat label="Equity" value={money(d.account?.equity)} sub={`Cash ${money(d.account?.cash)}`} />
        <Stat label="Gross Exposure" value={money(t.gross_exposure)} sub={t.gross_pct_equity != null ? `${t.gross_pct_equity}% of equity` : '—'} />
        <Stat label="Net Δ-Dollars" value={money(t.net_delta_dollars)} kind={signClass(t.net_delta_dollars)} sub={t.net_pct_equity != null ? `${t.net_pct_equity}% directional` : '—'} />
        <Stat label="Option Premium at Risk" value={money(t.option_premium_at_risk)} sub={`${t.positions} positions · ${t.underlyings} names`} />
      </div>

      {(d.flags || []).length > 0 && (
        <Card title={<span className="icon-btn"><Icon name="warning" size={15} /> Risk flags</span>}>
          <ul style={{ margin: 0, paddingLeft: 18 }}>
            {d.flags.map((f: string, i: number) => <li key={i} className="amber" style={{ marginBottom: 4 }}>{f}</li>)}
          </ul>
        </Card>
      )}

      <Card title={<>Exposure by underlying {d.largest_underlying && <span className="muted" style={{ fontWeight: 400, fontSize: 12 }}>· largest: {d.largest_underlying.underlying} ({d.largest_underlying.pct_of_equity}% of equity)</span>}</>}>
        <DataTable rows={uls} cols={ulCols} initialSort={{ key: 'delta_dollars', dir: -1 }} storageKey="pf_underlyings" filter={false} empty="No open exposure." rowKey={(r) => r.underlying} />
      </Card>

      {syms.length > 1 && (
        <Card title={<>Correlation matrix <Info text="90-day daily-return correlation between your held underlyings. Red = move together (concentration risk hiding behind multiple tickers). Green = offsetting." /></>}>
          <div style={{ overflowX: 'auto' }}>
            <table className="dense" style={{ minWidth: 360 }}>
              <thead><tr><th></th>{syms.map((s) => <th key={s} style={{ textAlign: 'center' }}><Sym>{s}</Sym></th>)}</tr></thead>
              <tbody>
                {syms.map((r) => (
                  <tr key={r}>
                    <td><Sym bold>{r}</Sym></td>
                    {syms.map((c) => {
                      const v = r === c ? 1 : (corrMap[`${r}|${c}`] ?? 0);
                      return <td key={c} style={{ textAlign: 'center', background: r === c ? 'rgba(120,120,120,0.25)' : corrColor(v), fontVariantNumeric: 'tabular-nums' }}>{r === c ? '—' : v.toFixed(2)}</td>;
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      {((d.redundancies || []).length > 0 || (d.bot_overlap || []).length > 0) && (
        <Card title="Redundancy / concentration scan">
          {(d.redundancies || []).map((r: any, i: number) => (
            <div key={i} className="row" style={{ gap: 8, marginBottom: 4 }}>
              <Badge kind={r.kind.startsWith('correlated') ? 'red' : 'green'}>{r.corr.toFixed(2)}</Badge>
              <span><Sym>{r.a}</Sym> ↔ <Sym>{r.b}</Sym> — {r.kind} ({money(r.combined_delta_dollars)} combined)</span>
            </div>
          ))}
          {(d.bot_overlap || []).map((o: any, i: number) => (
            <div key={`b${i}`} className="muted" style={{ fontSize: 12, marginTop: 4 }}>Bots <b>{o.a}</b> &amp; <b>{o.b}</b> both trade {o.shared.join(', ')} — same bet run twice.</div>
          ))}
        </Card>
      )}

      <Card title={<>Stress test (first-order, delta) <Info text="Estimated portfolio P/L if every underlying moved by the shown %, using delta only. Short-DTE options have gamma — real moves will exceed these straight-line numbers." /></>}>
        <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
          {(d.stress || []).map((s: any) => (
            <div key={s.move_pct} className="card" style={{ flex: 1, minWidth: 90, textAlign: 'center', padding: 8 }}>
              <div className={`${signClass(s.move_pct)}`} style={{ fontSize: 12 }}>{s.move_pct > 0 ? '+' : ''}{s.move_pct}% move</div>
              <div className={signClass(s.pl_usd)} style={{ fontWeight: 700 }}>{money(s.pl_usd)}</div>
              <div className="muted" style={{ fontSize: 11 }}>{s.pl_pct_equity != null ? pct(s.pl_pct_equity) : '—'}</div>
            </div>
          ))}
        </div>
      </Card>

      <Card title="Positions (delta-adjusted)">
        <DataTable rows={d.positions || []} cols={posCols} initialSort={{ key: 'delta_dollars', dir: -1 }} storageKey="pf_positions" filterPlaceholder="filter positions…" empty="No open positions." rowKey={(r, i) => r.occ_symbol || `${r.symbol}-${i}`} />
      </Card>

      <div className="muted" style={{ fontSize: 11 }}>{d.notes}</div>
    </div>
  );
}
