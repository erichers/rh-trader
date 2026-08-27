import { useState } from 'react';
import { Alerts, AlertSeen, AlertDismiss, AlertRules, SetAlertRules, RunAlertEngine } from '../api/client';
import { Card, Badge, Sym, Info, fmtDateTime, useAsync } from '../components/ui';
import { DataTable, type Column } from '../components/datatable';

// Alerts center — operational alerts (order fills, stop/TP exits, FAILED exits, drawdown breach,
// kill switch) from the engine, plus the AI news pipeline's alerts. Toggle which rules fire and
// set the intraday-drawdown threshold here.

const RULE_LABELS: Record<string, string> = {
  fills: 'Order fills', exits: 'Stop / take-profit exits', exit_failed: 'FAILED exits (critical)',
  drawdown: 'Intraday drawdown breach', kill_switch: 'Kill-switch changes',
};

function levelKind(l: string): string { return l === 'critical' ? 'red' : l === 'warn' ? 'amber' : 'blue'; }

function RulesPanel({ onChange }: { onChange: () => void }) {
  const { data, reload } = useAsync<any>(AlertRules, []);
  const [busy, setBusy] = useState(false);
  const r = data?.rules || {};
  const toggle = async (key: string, val: any) => {
    setBusy(true);
    try { await SetAlertRules({ [key]: val }); reload(); } finally { setBusy(false); }
  };
  const run = async () => { setBusy(true); try { await RunAlertEngine(); onChange(); } finally { setBusy(false); } };
  return (
    <Card title={<>Alert rules <Info text="Which operational events raise an alert. The engine runs every minute off a durable cursor, so each fill/exit alerts exactly once. Drawdown is intraday peak-to-current equity." /></>} right={<button onClick={run} disabled={busy}>{busy ? '…' : 'Run now'}</button>}>
      <div className="stack" style={{ gap: 6 }}>
        {Object.keys(RULE_LABELS).map((k) => (
          <label key={k} className="row" style={{ gap: 8, justifyContent: 'space-between' }}>
            <span>{RULE_LABELS[k]}</span>
            <input type="checkbox" checked={r[k] !== false} disabled={busy} onChange={(e) => toggle(k, e.target.checked)} />
          </label>
        ))}
        <label className="row" style={{ gap: 8, justifyContent: 'space-between', marginTop: 4 }}>
          <span>Drawdown threshold</span>
          <span className="row" style={{ gap: 4 }}>
            <input type="number" min={1} max={50} step={0.5} value={r.drawdown_pct ?? 5} disabled={busy} style={{ width: 64 }}
              onChange={(e) => toggle('drawdown_pct', Number(e.target.value))} />%
          </span>
        </label>
      </div>
    </Card>
  );
}

export default function AlertsView() {
  const { data, reload, loading } = useAsync<any[]>(() => Alerts(100), [], 15000);
  const alerts = (data || []) as any[];
  const act = async (fn: Promise<any>) => { await fn; reload(); };

  const cols: Column<any>[] = [
    { key: 'created_at', label: 'When', sortValue: (r) => Date.parse(r.created_at), render: (r) => <span style={{ fontSize: 12 }}>{fmtDateTime(r.created_at)}</span> },
    { key: 'level', label: 'Level', render: (r) => <Badge kind={levelKind(r.level)}>{r.level}</Badge> },
    { key: 'source', label: 'Source', render: (r) => <Badge kind="gray">{r.source}</Badge> },
    { key: 'title', label: 'Alert', filterValue: (r) => `${r.title} ${r.body || ''} ${r.symbol || ''}`, render: (r) => (
      <div>
        <div>{r.symbol ? <Sym>{r.symbol}</Sym> : null} {r.title}</div>
        {r.body && <div className="muted" style={{ fontSize: 11 }}>{r.body}</div>}
      </div>
    ) },
    { key: 'status', label: 'Status', render: (r) => <Badge kind={r.status === 'new' ? 'amber' : 'gray'}>{r.status}</Badge> },
    { key: '_act', label: '', sortable: false, render: (r) => (
      <span className="row" style={{ gap: 4 }}>
        {r.status === 'new' && <button onClick={() => act(AlertSeen(r.id))} title="mark seen">seen</button>}
        <button onClick={() => act(AlertDismiss(r.id))} title="dismiss">×</button>
      </span>
    ) },
  ];

  const newCount = alerts.filter((a) => a.status === 'new').length;
  const critCount = alerts.filter((a) => a.level === 'critical' && a.status !== 'dismissed').length;

  return (
    <div className="stack" style={{ gap: 14 }}>
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
        <h2 style={{ margin: 0 }}>Alerts {newCount > 0 && <Badge kind="amber">{newCount} new</Badge>} {critCount > 0 && <Badge kind="red">{critCount} critical</Badge>}</h2>
        {loading && <span className="muted">↻</span>}
      </div>
      <div className="grid2" style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr) 280px', gap: 14, alignItems: 'start' }}>
        <Card title="Feed">
          <DataTable rows={alerts} cols={cols} initialSort={{ key: 'created_at', dir: -1 }} storageKey="alerts_feed" pageSize={30} filterPlaceholder="filter alerts…" empty="No alerts." rowKey={(r) => r.id} />
        </Card>
        <RulesPanel onChange={reload} />
      </div>
    </div>
  );
}
