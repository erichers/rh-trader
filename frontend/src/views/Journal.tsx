import { useState } from 'react';
import { Journal, SetJournalMeta } from '../api/client';
import { Card, money, pct, signClass, Badge, Sym, Info, fmtDateTime, useAsync } from '../components/ui';
import { DataTable, type Column } from '../components/datatable';
import { Icon } from '../components/icons';

// Trade journal — every row is a REAL round-trip (closed position monitor): entry fill → exit
// fill, exit reason, realized P/L. Add your own tags + notes + a reviewed flag to build a
// reviewable record. Tags/notes never touch trading.

function TagEditor({ trade, onSaved }: { trade: any; onSaved: () => void }) {
  const [tags, setTags] = useState<string>((trade.tags || []).join(', '));
  const [note, setNote] = useState<string>(trade.note || '');
  const [reviewed, setReviewed] = useState<boolean>(!!trade.reviewed);
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    try {
      await SetJournalMeta(trade.id, { tags: tags.split(',').map((s) => s.trim()).filter(Boolean), note, reviewed });
      onSaved();
    } finally { setBusy(false); }
  };
  return (
    <div className="card" style={{ background: 'rgba(255,255,255,0.02)', marginTop: 8 }}>
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <b><Sym>{trade.symbol}</Sym> {trade.occ_symbol ? <span className="muted" style={{ fontSize: 11 }}>{trade.occ_symbol}</span> : ''} · <span className={signClass(trade.pnl_pct)}>{pct(trade.pnl_pct)}</span> ({money(trade.pnl_usd)})</b>
        <span className="muted" style={{ fontSize: 11 }}>{trade.bot_name} · {trade.reason || trade.status}</span>
      </div>
      <div className="stack" style={{ gap: 6, marginTop: 8 }}>
        <label className="muted" style={{ fontSize: 11 }}>Tags (comma-separated)
          <input value={tags} onChange={(e) => setTags(e.target.value)} placeholder="e.g. momentum, earnings, mistake" style={{ width: '100%' }} />
        </label>
        <label className="muted" style={{ fontSize: 11 }}>Note
          <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2} placeholder="What worked / what you'd change…" style={{ width: '100%' }} />
        </label>
        <label className="row" style={{ gap: 6, fontSize: 12 }}><input type="checkbox" checked={reviewed} onChange={(e) => setReviewed(e.target.checked)} /> Reviewed</label>
        <div className="row" style={{ gap: 6 }}>
          <button className="primary" onClick={save} disabled={busy}>{busy ? 'Saving…' : 'Save'}</button>
        </div>
      </div>
    </div>
  );
}

export default function JournalView() {
  const [status, setStatus] = useState<'closed' | 'open' | 'all'>('closed');
  const { data, loading, reload } = useAsync<any>(() => Journal({ status, limit: 300 }), [status], 30000);
  const [sel, setSel] = useState<number | null>(null);

  const d = data || {};
  const s = d.summary || {};
  const trades: any[] = d.trades || [];
  const selTrade = trades.find((t) => t.id === sel);

  const cols: Column<any>[] = [
    { key: 'closed_at', label: 'Closed', sortValue: (r) => r.closed_at ? Date.parse(r.closed_at) : (r.opened_at ? Date.parse(r.opened_at) : 0), render: (r) => <span style={{ fontSize: 12 }}>{r.closed_at ? fmtDateTime(r.closed_at) : <Badge kind="amber">open</Badge>}</span> },
    { key: 'symbol', label: 'Symbol', render: (r) => <span><Sym>{r.symbol}</Sym>{(r.asset_class === 'option') && <span className="muted" style={{ fontSize: 10 }}> opt</span>}</span> },
    { key: 'bot_name', label: 'Bot', render: (r) => <span style={{ fontSize: 12 }}>{r.bot_name}</span> },
    { key: 'reason', label: 'Exit', render: (r) => r.reason ? <Badge kind={r.reason.includes('take-profit') ? 'green' : r.reason.includes('stop') ? 'red' : 'gray'}>{r.reason}</Badge> : <span className="muted">—</span> },
    { key: 'entry_price', label: 'Entry', align: 'right', render: (r) => num4(r.entry_price) },
    { key: 'exit_used', label: 'Exit', align: 'right', render: (r) => <span title={r.exit_is_fill ? 'broker fill' : 'last/trigger price (no fill reported)'}>{num4(r.exit_used)}{!r.exit_is_fill && r.status === 'closed' ? '≈' : ''}</span> },
    { key: 'pnl_pct', label: 'P/L %', align: 'right', sortValue: (r) => r.pnl_pct, render: (r) => <span className={signClass(r.pnl_pct)}>{pct(r.pnl_pct)}</span> },
    { key: 'pnl_usd', label: 'P/L $', align: 'right', sortValue: (r) => r.pnl_usd, render: (r) => <span className={signClass(r.pnl_usd)}>{money(r.pnl_usd)}</span> },
    { key: 'tags', label: 'Tags', sortable: false, filterValue: (r) => (r.tags || []).join(' ') + ' ' + (r.note || ''), render: (r) => (
      <span className="row" style={{ gap: 3, flexWrap: 'wrap' }}>
        {(r.tags || []).map((t: string) => <Badge key={t} kind="blue">{t}</Badge>)}
        {r.reviewed && <Badge kind="green"><Icon name="check" size={11} /></Badge>}
      </span>
    ) },
    { key: '_edit', label: '', sortable: false, render: (r) => <button onClick={() => setSel(sel === r.id ? null : r.id)}>{sel === r.id ? 'close' : 'tag'}</button> },
  ];

  return (
    <div className="stack" style={{ gap: 14 }}>
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
        <h2 style={{ margin: 0 }}>Trade Journal <Info text="Auto-populated from real round-trips (closed position monitors). Entry & exit are real fills (exit marked ≈ when the broker didn't report a fill and the trigger price was used). Add tags + notes to review your trading." /></h2>
        <div className="seg">
          {(['closed', 'open', 'all'] as const).map((v) => <button key={v} className={status === v ? 'on' : ''} onClick={() => setStatus(v)}>{v}</button>)}
        </div>
      </div>

      <div className="row" style={{ gap: 10, flexWrap: 'wrap' }}>
        <Mini label="Closed trades" value={s.closed_trades ?? 0} />
        <Mini label="Win rate" value={`${s.win_rate ?? 0}%`} kind={(s.win_rate ?? 0) >= 50 ? 'green' : 'red'} />
        <Mini label="Total P/L" value={money(s.total_pnl_usd)} kind={signClass(s.total_pnl_usd)} />
        <Mini label="Avg / trade" value={pct(s.avg_pnl_pct)} kind={signClass(s.avg_pnl_pct)} />
        <Mini label="Best / Worst" value={<><span className="green">{s.best_pct != null ? pct(s.best_pct) : '—'}</span> / <span className="red">{s.worst_pct != null ? pct(s.worst_pct) : '—'}</span></>} />
        <Mini label="Reviewed" value={`${s.reviewed ?? 0}/${s.closed_trades ?? 0}`} />
      </div>

      {(d.by_bot || []).length > 0 && (
        <Card title="By bot">
          <DataTable rows={d.by_bot} cols={[
            { key: 'key', label: 'Bot' },
            { key: 'n', label: 'Trades', align: 'right' },
            { key: 'win_rate', label: 'Win %', align: 'right', render: (r: any) => `${r.win_rate}%` },
            { key: 'pnl_usd', label: 'P/L $', align: 'right', render: (r: any) => <span className={signClass(r.pnl_usd)}>{money(r.pnl_usd)}</span> },
          ] as Column<any>[]} filter={false} initialSort={{ key: 'pnl_usd', dir: -1 }} rowKey={(r) => r.key} />
        </Card>
      )}

      <Card title="Trades" right={loading ? <span className="muted">↻</span> : null}>
        <DataTable rows={trades} cols={cols} initialSort={{ key: 'closed_at', dir: -1 }} storageKey="journal" pageSize={25} filterPlaceholder="filter symbol / tag / note…" empty="No trades yet — they appear here automatically as positions close." rowKey={(r) => r.id} />
        {selTrade && <TagEditor trade={selTrade} onSaved={() => { setSel(null); reload(); }} />}
      </Card>

      <div className="muted" style={{ fontSize: 11 }}>{d.note}</div>
    </div>
  );
}

function Mini({ label, value, kind }: { label: string; value: React.ReactNode; kind?: string }) {
  return (
    <div className="card" style={{ flex: 1, minWidth: 110, padding: 10 }}>
      <div className="muted" style={{ fontSize: 11 }}>{label}</div>
      <div className={kind} style={{ fontSize: 18, fontWeight: 700 }}>{value}</div>
    </div>
  );
}
function num4(v: any): string { const n = Number(v); return Number.isFinite(n) ? n.toFixed(n >= 100 ? 2 : 4) : '—'; }
