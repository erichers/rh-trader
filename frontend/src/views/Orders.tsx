import { useState } from 'react';
import { Orders, Approvals, ApproveOrder, RejectOrder, PlaceOrder, RiskCheck, TradeAnalysis, TuneBots } from '../api/client';
import { Card, money, num, pct, signClass, statusBadge, useAsync, Sym, Info, Badge, fmtDateTime } from '../components/ui';
import { DataTable, type Column } from '../components/datatable';

/** Per-bot performance rollup + trade forensics (real round-trips with entry→peak→exit),
 *  each with a plain-English suggested improvement. Powers the "why did this trade do that"
 *  layer of the Orders tab. */
function AnalysisSection() {
  const [days, setDays] = useState(7);
  const { data, loading, reload } = useAsync<any>(() => TradeAnalysis(days), [days], 30000);
  const [open, setOpen] = useState<number | null>(null);
  const [tuning, setTuning] = useState(false);
  const [tuneMsg, setTuneMsg] = useState('');
  const d = data || {};
  const s = d.summary || {};
  const trades: any[] = d.trades || [];
  const sel = trades.find((t) => t.id === open);

  const tune = async () => {
    if (!confirm('Retune every bot\'s stop/trail from its own realized trade history?\n\nConservative: moves halfway toward what the data supports, needs ≥6 trades, never touches open positions.')) return;
    setTuning(true); setTuneMsg('');
    try {
      const r = await TuneBots(14, true);
      const applied = r.bots.filter((b: any) => b.applied);
      setTuneMsg(applied.length ? `Tuned ${applied.map((b: any) => b.name).join(', ')}` : 'No changes met the evidence bar (need ≥6 trades + a real pattern).');
      reload();
    } catch (e: any) { setTuneMsg('Tune failed: ' + String(e?.message || e)); }
    finally { setTuning(false); }
  };

  const botCols: Column<any>[] = [
    { key: 'name', label: 'Bot', render: (b) => <b>{b.name}</b> },
    { key: 'n', label: 'Trades', align: 'right' },
    { key: 'win_rate', label: 'Win %', align: 'right', render: (b) => `${b.win_rate}%` },
    { key: 'avg_win_pct', label: 'Avg win', align: 'right', render: (b) => <span className="green">+{b.avg_win_pct}%</span> },
    { key: 'avg_loss_pct', label: 'Avg loss', align: 'right', render: (b) => <span className="red">−{b.avg_loss_pct}%</span> },
    { key: 'payoff', label: 'Payoff', align: 'right', render: (b) => `${b.payoff}:1` },
    { key: 'expectancy_pct', label: 'Expectancy', align: 'right', render: (b) => <span className={signClass(b.expectancy_pct)}>{pct(b.expectancy_pct)}</span> },
    { key: 'total_pl_pct', label: 'Total P/L %', align: 'right', render: (b) => <span className={signClass(b.total_pl_pct)} style={{ fontWeight: 700 }}>{pct(b.total_pl_pct)}</span> },
    { key: 'current', label: 'Stops now', sortable: false, render: (b) => <span className="muted" style={{ fontSize: 11 }}>−{b.current.sl}% / trail {b.current.trail}</span> },
    { key: 'recommend', label: 'History says', sortable: false, render: (b) => b.recommend.changed
      ? <span className="amber" style={{ fontSize: 11 }} title={b.recommend.rationale.join(' ')}>−{b.recommend.sl}% / trail {b.recommend.trail} ({b.recommend.confidence})</span>
      : <span className="muted" style={{ fontSize: 11 }} title={b.recommend.rationale.join(' ')}>keep ({b.recommend.confidence})</span> },
  ];

  const tradeCols: Column<any>[] = [
    { key: 'closed_at', label: 'Closed', sortValue: (t) => t.closed_at ? Date.parse(t.closed_at) : Date.parse(t.opened_at) + 1e12, render: (t) => t.status === 'open' ? <Badge kind="amber">open</Badge> : <span className="muted" style={{ fontSize: 12 }}>{fmtDateTime(t.closed_at)}</span> },
    { key: 'symbol', label: 'Symbol', filterValue: (t) => `${t.symbol} ${t.bot_name} ${t.reason || ''}`, render: (t) => <Sym bold>{t.symbol}</Sym> },
    { key: 'bot_name', label: 'Bot', render: (t) => <span style={{ fontSize: 12 }}>{t.bot_name}</span> },
    { key: 'entry', label: 'Entry', align: 'right', render: (t) => num(t.entry, 2) },
    { key: 'exit', label: 'Exit', align: 'right', render: (t) => t.exit != null ? <span title={t.exit_is_fill ? 'actual fill' : 'trigger price ≈ fill'}>{num(t.exit, 2)}{!t.exit_is_fill ? '≈' : ''}</span> : '—' },
    { key: 'pl_pct', label: 'P/L %', align: 'right', sortValue: (t) => t.pl_pct, render: (t) => <b className={signClass(t.pl_pct)}>{pct(t.pl_pct)}</b> },
    { key: 'peak_pct', label: 'Peak %', align: 'right', sortValue: (t) => t.peak_pct, render: (t) => <span className="muted">+{t.peak_pct}%</span> },
    { key: 'giveback_pct', label: 'Giveback', align: 'right', sortValue: (t) => t.giveback_pct ?? 0, render: (t) => t.giveback_pct != null ? <span className={t.giveback_pct > 42 ? 'amber' : 'muted'}>{num(t.giveback_pct, 1)}</span> : '—' },
    { key: 'hold_min', label: 'Held', align: 'right', render: (t) => t.hold_min != null ? (t.hold_min >= 60 ? `${Math.round(t.hold_min / 60 * 10) / 10}h` : `${t.hold_min}m`) : '—' },
    { key: 'reason', label: 'Exit via', render: (t) => t.reason ? <Badge kind={t.reason.includes('take-profit') || t.reason.includes('breakeven') ? 'green' : t.reason.includes('stop') ? 'red' : 'gray'}>{t.reason}</Badge> : <span className="muted">—</span> },
    { key: '_d', label: '', sortable: false, render: (t) => <button onClick={() => setOpen(open === t.id ? null : t.id)}>{open === t.id ? 'close' : 'details'}</button> },
  ];

  return (
    <>
      <Card title={<>Trade performance <Info text="Every row is a real round-trip: entry fill → actual exit, with the peak (best it ever looked) and giveback (peak − realized). Suggestions are generated from what actually happened, referencing the breakeven-lock + ratcheting-trail exits now live." /></>}
        right={<span className="row" style={{ gap: 6 }}>
          <div className="seg">{[1, 7, 30].map((v) => <button key={v} className={days === v ? 'on' : ''} onClick={() => setDays(v)}>{v === 1 ? 'today' : `${v}d`}</button>)}</div>
          <button onClick={tune} disabled={tuning}>{tuning ? 'Tuning…' : 'Tune bots from history'}</button>
        </span>}>
        {loading && !data ? <div className="muted">Analyzing trades…</div> : (
          <div className="stack" style={{ gap: 12 }}>
            <div className="row" style={{ gap: 10, flexWrap: 'wrap' }}>
              <Chip label="Round-trips" value={s.trades ?? 0} />
              <Chip label="Win rate" value={`${s.win_rate ?? 0}%`} kind={(s.win_rate ?? 0) >= 50 ? 'green' : 'amber'} />
              <Chip label="Avg win" value={`+${s.avg_win_pct ?? 0}%`} kind="green" />
              <Chip label="Avg loss" value={`−${s.avg_loss_pct ?? 0}%`} kind="red" />
              <Chip label="Total P/L" value={pct(s.total_pl_pct)} kind={signClass(s.total_pl_pct)} />
              {(d.daily || []).map((day: any) => <Chip key={day.date} label={day.date.slice(5)} value={pct(day.pl_sum)} kind={signClass(day.pl_sum)} sub={`${day.wins}/${day.n} wins`} />)}
            </div>
            {tuneMsg && <div className="muted" style={{ fontSize: 12 }}>{tuneMsg}</div>}
            {(d.bots || []).length > 0 && (
              <DataTable rows={d.bots} cols={botCols} filter={false} initialSort={{ key: 'total_pl_pct', dir: -1 }} rowKey={(b) => b.bot_id} />
            )}
            <DataTable rows={trades} cols={tradeCols} storageKey="trade-analysis" initialSort={{ key: 'closed_at', dir: -1 }} pageSize={20} filterPlaceholder="filter symbol/bot/exit…" empty="No monitored round-trips in this window." rowKey={(t) => t.id} />
            {sel && (
              <div className="card" style={{ background: 'rgba(0,200,5,0.04)' }}>
                <div className="row" style={{ justifyContent: 'space-between' }}>
                  <b><Sym>{sel.symbol}</Sym> {sel.occ_symbol && <span className="muted" style={{ fontSize: 11 }}>{sel.occ_symbol}</span>} · <span className={signClass(sel.pl_pct)}>{pct(sel.pl_pct)}</span></b>
                  <span className="muted" style={{ fontSize: 11 }}>{sel.bot_name} · stop −{sel.sl_pct}% / trail {sel.trail_pct}{sel.tp_pct > 0 ? ` / cap +${sel.tp_pct}%` : ' / no cap'}</span>
                </div>
                <div style={{ marginTop: 6, fontSize: 13 }}>
                  Entry {num(sel.entry, 2)} → exit {sel.exit != null ? num(sel.exit, 2) : '—'}{!sel.exit_is_fill && sel.exit != null ? ' (trigger≈fill)' : ''} · peaked <b>+{sel.peak_pct}%</b>{sel.trough_pct != null ? <> · worst dip <b>{sel.trough_pct}%</b></> : null}{sel.giveback_pct != null ? <> · gave back <b>{num(sel.giveback_pct, 1)}pts</b></> : null} · held {sel.hold_min != null ? (sel.hold_min >= 60 ? `${Math.round(sel.hold_min / 60 * 10) / 10}h` : `${sel.hold_min}m`) : '—'}
                </div>
                <div style={{ marginTop: 6, fontSize: 13 }} className={sel.pl_pct >= 0 ? 'green' : 'amber'}>{sel.suggestion}</div>
              </div>
            )}
            <div className="muted" style={{ fontSize: 11 }}>{d.note}</div>
          </div>
        )}
      </Card>
    </>
  );
}

function Chip({ label, value, kind, sub }: { label: string; value: any; kind?: string; sub?: string }) {
  return (
    <div className="card" style={{ padding: '8px 12px', minWidth: 92 }}>
      <div className="muted" style={{ fontSize: 10, textTransform: 'uppercase', letterSpacing: 0.4 }}>{label}</div>
      <div className={kind} style={{ fontSize: 16, fontWeight: 700 }}>{value}</div>
      {sub && <div className="muted" style={{ fontSize: 10 }}>{sub}</div>}
    </div>
  );
}

export default function OrdersView() {
  const orders = useAsync<any[]>(() => Orders(200), [], 6000);
  const appr = useAsync<any[]>(Approvals, [], 6000);
  const [draft, setDraft] = useState<any>({ symbol: '', side: 'buy', qty: 1, asset_class: 'option', option_type: 'call', order_type: 'market', est_price: '' });
  const [preview, setPreview] = useState<any>(null);
  const [msg, setMsg] = useState('');

  const set = (k: string, v: any) => setDraft((d: any) => ({ ...d, [k]: v }));
  const body = () => ({ ...draft, qty: Number(draft.qty), est_price: draft.est_price ? Number(draft.est_price) : undefined });

  const doPreview = async () => {
    setMsg('');
    try { setPreview(await RiskCheck(body())); }
    catch (e: any) { setPreview(null); setMsg('Risk check failed: ' + String(e)); }
  };
  const doPlace = async () => {
    setMsg('');
    try {
      const r = await PlaceOrder(body());
      setMsg(`${r.action.toUpperCase()} — ${r.status} — ${r.reason}`);
      orders.reload(); appr.reload();
    } catch (e: any) { setMsg('Order rejected: ' + String(e)); }
  };

  return (
    <div className="grid" style={{ gap: 14 }}>
      <AnalysisSection />

      <Card title="Manual Order (routed through risk engine + mode)">
        <div className="row">
          <input placeholder="Symbol" style={{ width: 90 }} value={draft.symbol} onChange={(e) => set('symbol', e.target.value.toUpperCase())} />
          <select value={draft.asset_class} onChange={(e) => set('asset_class', e.target.value)}>
            <option value="equity">equity</option><option value="etf">etf</option><option value="option">option</option>
          </select>
          <select value={draft.side} onChange={(e) => set('side', e.target.value)}>
            <option value="buy">buy</option><option value="sell">sell</option>
          </select>
          {draft.asset_class === 'option' && (
            <select value={draft.option_type || 'call'} onChange={(e) => set('option_type', e.target.value)}>
              <option value="call">call</option><option value="put">put</option>
            </select>
          )}
          <input placeholder="Qty" style={{ width: 70 }} value={draft.qty} onChange={(e) => set('qty', e.target.value)} />
          <input placeholder="Est price" style={{ width: 90 }} value={draft.est_price} onChange={(e) => set('est_price', e.target.value)} />
          <button onClick={doPreview}>Risk preview</button>
          <button className="primary" onClick={doPlace} disabled={!draft.symbol}>Submit</button>
        </div>
        {msg && <div style={{ marginTop: 8 }} className="muted">{msg}</div>}
        {preview && (
          <div style={{ marginTop: 10 }}>
            <b className={preview.ok ? 'green' : 'red'}>{preview.ok ? 'WOULD ALLOW' : 'WOULD VETO'}</b> — {preview.reason}
            <table style={{ marginTop: 6 }}>
              <tbody>
                {Object.entries(preview.checks).map(([k, v]: any) => (
                  <tr key={k}><td>{k}</td><td className={v.pass ? 'green' : 'red'}>{v.pass ? 'pass' : 'fail'}</td><td className="muted">{v.detail}</td></tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {(appr.data || []).length > 0 && (
        <Card title={`Pending Approvals (${appr.data!.length})`}>
          <table>
            <thead><tr><th>Symbol</th><th>Side</th><th>Qty</th><th></th></tr></thead>
            <tbody>
              {appr.data!.map((a) => (
                <tr key={a.id}>
                  <td><Sym bold>{a.symbol}</Sym></td><td>{a.side}</td><td>{num(a.qty, 0)}</td>
                  <td className="row">
                    <button className="primary" onClick={async () => { await ApproveOrder(a.id); appr.reload(); orders.reload(); }}>Approve</button>
                    <button className="danger" onClick={async () => { await RejectOrder(a.id); appr.reload(); orders.reload(); }}>Reject</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}

      <Card title={`Order History (${(orders.data || []).length})`}>
        <DataTable
          rows={orders.data || []}
          storageKey="orders-history"
          initialSort={{ key: 'created_at', dir: -1 }}
          pageSize={25}
          filterPlaceholder="filter symbol/status/source…"
          empty="No orders yet."
          cols={[
            { key: 'created_at', label: 'Time', sortValue: (o) => o.created_at || '', render: (o) => <span className="muted">{fmtDateTime(o.created_at)}</span> },
            { key: 'symbol', label: 'Symbol', sortValue: (o) => o.symbol, filterValue: (o) => `${o.symbol} ${o.side} ${o.status} ${o.source} ${o.mode}`, render: (o) => <Sym bold>{o.symbol}</Sym> },
            { key: 'side', label: 'Side', sortValue: (o) => o.side, align: 'center', render: (o) => <span className={o.side === 'buy' ? 'green' : 'red'}>{o.side}</span> },
            { key: 'qty', label: 'Qty', align: 'right', sortValue: (o) => Number(o.qty), render: (o) => num(o.qty, 0) },
            { key: 'price', label: 'Price', align: 'right', sortValue: (o) => Number(o.filled_price ?? o.limit_price ?? 0), render: (o) => { const px = o.filled_price ?? o.limit_price; return px != null ? money(px) : <span className="muted">mkt</span>; } },
            { key: 'order_type', label: 'Type', sortValue: (o) => o.order_type, render: (o) => o.order_type },
            { key: 'status', label: 'Status', sortValue: (o) => o.status, align: 'center', render: (o) => statusBadge(o.status) },
            { key: 'mode', label: 'Mode', sortValue: (o) => o.mode, align: 'center', render: (o) => <span className="pill">{o.mode}</span> },
            { key: 'source', label: 'Src', sortValue: (o) => o.source, align: 'center', render: (o) => <span className="pill">{o.source}</span> },
            { key: 'risk_reason', label: 'Reason', sortable: false, render: (o) => <span className="muted" style={{ maxWidth: 240, fontSize: 11, display: 'inline-block' }}>{o.risk_reason}</span> },
          ]}
        />
      </Card>
    </div>
  );
}
