import { useState } from 'react';
import { LearningStatus, LearningRuns, LearningIdeas, RunLearning } from '../api/client';
import { Card, Badge, Info, Sym, fmtDateTime, useAsync } from '../components/ui';
import { DataTable, type Column } from '../components/datatable';
import { Icon } from '../components/icons';

// Learning iterator. Once a day after the close (and once more on Sunday), this account's own
// record is gathered, reviewed by the model, turned into new strategy ideas, and every idea is
// backtested on real bars. Only ideas that clear the robustness gate become bots, and those
// bots are created DISABLED in cautious mode: nothing here can trade until you enable it.

const HORIZON_LABEL: Record<string, string> = {
  daytrade: 'Day trade',
  swing_daily: 'Swing (daily)',
  swing_weekly: 'Swing (weekly)',
};

function statusKind(s: string): string {
  return s === 'kept' || s === 'done' ? 'green' : s === 'retired' || s === 'error' ? 'red' : s === 'dry_run' ? 'blue' : 'gray';
}

function n2(v: any, d = 2): string {
  return Number.isFinite(Number(v)) ? Number(v).toFixed(d) : '-';
}

// Two backtest engines score in different units: option ideas price the ATM contract's
// premium, equity ideas price the underlying share. Same-looking percent, different thing.
const ENGINE_UNIT: Record<string, string> = { quickbot_bsm: 'option premium', equity_rules: 'share price' };

export default function LearningView() {
  const { data: status, reload: reloadStatus } = useAsync<any>(() => LearningStatus(), [], 60000);
  const { data: runsData, loading: runsLoading, reload: reloadRuns } = useAsync<any>(() => LearningRuns(30), [], 60000);
  const { data: ideasData, loading: ideasLoading, reload: reloadIdeas } = useAsync<any>(() => LearningIdeas(), [], 60000);
  const [filter, setFilter] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<any>(null);
  const [err, setErr] = useState('');
  const [openRun, setOpenRun] = useState<number | null>(null);

  const runs: any[] = runsData?.runs || [];
  const ideas: any[] = (ideasData?.ideas || []).filter((i: any) => !filter || i.status === filter);

  const dryRun = async () => {
    setBusy(true); setErr(''); setResult(null);
    try {
      const r = await RunLearning({ kind: 'daily', dry_run: true });
      setResult(r);
      reloadStatus(); reloadRuns(); reloadIdeas();
    } catch (e: any) {
      setErr(String(e?.message || e));
    } finally { setBusy(false); }
  };

  const runCols: Column<any>[] = [
    { key: 'run_date', label: 'Date', render: (r) => <span>{r.run_date}</span> },
    { key: 'kind', label: 'Kind', render: (r) => <Badge kind={r.kind === 'weekly' ? 'blue' : 'gray'}>{r.kind}</Badge> },
    { key: 'status', label: 'Status', render: (r) => <Badge kind={statusKind(r.status)}>{r.status}</Badge> },
    { key: 'model', label: 'Model', render: (r) => <span className="muted" style={{ fontSize: 11 }}>{r.model || '-'}</span> },
    { key: 'ideas_tested', label: 'Tested', align: 'right' },
    { key: 'ideas_kept', label: 'Kept', align: 'right', render: (r) => <b>{r.ideas_kept}</b> },
    { key: 'lessons', label: 'Lessons', align: 'right', sortValue: (r) => (r.lessons || []).length, render: (r) => (r.lessons || []).length },
    { key: 'created_at', label: 'Ran at', render: (r) => <span className="muted" style={{ fontSize: 11 }}>{fmtDateTime(r.created_at)}</span> },
    { key: 'open', label: '', sortable: false, render: (r) => <button onClick={() => setOpenRun(openRun === r.id ? null : r.id)}>{openRun === r.id ? 'Hide' : 'Lessons'}</button> },
  ];

  const ideaCols: Column<any>[] = [
    { key: 'generation', label: 'Gen', align: 'right', render: (r) => <span>G{r.generation}</span> },
    { key: 'name', label: 'Idea', render: (r) => {
      const notes = [r.backtest?.note, r.backtest?.robust_note].filter(Boolean).join(' ');
      return (
        <span title={notes || undefined}>
          <b>{r.name}</b>
          {r.universe?.length ? <span className="muted" style={{ fontSize: 11 }}> · {r.universe.join(', ')}</span> : null}
        </span>
      );
    } },
    { key: 'horizon', label: 'Horizon', render: (r) => <span>{HORIZON_LABEL[r.horizon] || r.horizon}</span> },
    { key: 'asset_class', label: 'Class', render: (r) => <span>{r.asset_class === 'option' ? `${r.direction || 'option'}` : 'equity'}</span> },
    { key: 'expectancy', label: 'Expectancy', align: 'right', sortValue: (r) => Number(r.backtest?.expectancy_pct ?? -999), render: (r) => {
      if (r.backtest?.expectancy_pct == null) return <span className="muted">-</span>;
      const unit = ENGINE_UNIT[r.backtest?.engine];
      return <span>{n2(r.backtest.expectancy_pct)}%{unit ? <span className="muted" style={{ fontSize: 11 }}> ({unit})</span> : null}</span>;
    } },
    { key: 'pf', label: 'PF', align: 'right', sortValue: (r) => Number(r.backtest?.profit_factor ?? -1), render: (r) => (r.backtest?.profit_factor != null ? n2(r.backtest.profit_factor) : '-') },
    { key: 'n', label: 'n', align: 'right', sortValue: (r) => Number(r.backtest?.num_trades ?? 0), render: (r) => r.backtest?.num_trades ?? '-' },
    { key: 'robust', label: 'Robust', align: 'center', sortValue: (r) => (r.backtest?.robust ? 1 : 0), render: (r) => (r.backtest?.robust ? <Icon name="check" size={14} /> : <span className="muted">no</span>) },
    { key: 'status', label: 'Status', render: (r) => <Badge kind={statusKind(r.status)}>{r.status}</Badge> },
    { key: 'bot', label: 'Bot', render: (r) => (r.bot_id
      ? <a href={`#/bots`} title={`${r.bot_name} (${r.bot_enabled ? 'enabled' : 'disabled'}, ${r.bot_mode})`}>#{r.bot_id} {r.bot_enabled ? 'enabled' : 'disabled'}</a>
      : <span className="muted">{r.backtest?.rejected ? 'invalid' : 'not kept'}</span>) },
  ];

  const shown = runs.find((r) => r.id === openRun);

  return (
    <div className="stack" style={{ gap: 14 }}>
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
        <h2 style={{ margin: 0 }} className="icon-btn">
          <Icon name="learn" size={20} /> Learning
          <Info text="Once a day after the close (and again on Sunday) this account's own trades, option outcomes, vetoes, signal hit-rate and bot expectancy are reviewed by the model, which proposes new strategies in the engine's rule vocabulary. Every idea is backtested on real bars; only the robust ones become bots, and those bots are created disabled." />
        </h2>
        <div className="row" style={{ gap: 8, alignItems: 'center' }}>
          <span className="muted" style={{ fontSize: 12 }}>{status?.env}</span>
          <button onClick={dryRun} disabled={busy}>{busy ? 'Running...' : 'Run now (dry run)'}</button>
        </div>
      </div>

      <div className="muted" style={{ fontSize: 12 }}>
        A dry run does the full pass (evidence, review, backtests) and writes nothing: no bots, no ideas, no learnings.
        Kept ideas from a real run always arrive as DISABLED bots in cautious mode. You promote them, the iterator never does.
      </div>

      <div className="quant-grid" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: 14, alignItems: 'start' }}>
        <Card title="Status">
          <div className="stack" style={{ gap: 6, fontSize: 13 }}>
            <div className="row" style={{ justifyContent: 'space-between' }}><span className="muted">Last run</span><span>{status?.last_run ? `${status.last_run.run_date} ${status.last_run.kind} (${status.last_run.status})` : 'none yet'}</span></div>
            <div className="row" style={{ justifyContent: 'space-between' }}><span className="muted">Generation</span><span>G{status?.counts?.generation ?? 0}</span></div>
            <div className="row" style={{ justifyContent: 'space-between' }}><span className="muted">Ideas</span><span>{status?.counts?.ideas ?? 0} total · {status?.counts?.kept ?? 0} kept · {status?.counts?.retired ?? 0} retired</span></div>
            <div className="row" style={{ justifyContent: 'space-between' }}><span className="muted">Eligible</span><span>{status?.eligible ? 'yes' : 'not enough history yet'}</span></div>
            <div className="muted" style={{ fontSize: 11 }}>{status?.schedule}</div>
            <div className="muted" style={{ fontSize: 11 }}>Gate: {status?.gate}</div>
          </div>
        </Card>

        {(result || err) && (
          <Card title={err ? 'Dry run failed' : 'Dry run result'} right={<button onClick={() => { setResult(null); setErr(''); }}>Clear</button>}>
            {err ? <div className="red" style={{ fontSize: 12 }}>{err}</div> : (
              <div className="stack" style={{ gap: 6, fontSize: 13 }}>
                <div className="row" style={{ justifyContent: 'space-between' }}><span className="muted">Model</span><span style={{ fontSize: 11 }}>{result.model}</span></div>
                <div className="row" style={{ justifyContent: 'space-between' }}><span className="muted">Lessons</span><span>{result.lessons}</span></div>
                <div className="row" style={{ justifyContent: 'space-between' }}><span className="muted">Ideas</span><span>{result.ideas?.returned} returned · {result.ideas?.valid} valid · {result.ideas?.tested} backtested · {result.ideas?.kept} would be kept</span></div>
                <div className="row" style={{ justifyContent: 'space-between' }}><span className="muted">LLM calls</span><span>{result.llm_calls}</span></div>
                <div className="muted" style={{ fontSize: 11 }}>Dry run: nothing was written.</div>
                {(result.results || []).map((r: any, i: number) => (
                  <div key={i} style={{ borderTop: '1px solid rgba(255,255,255,0.06)', paddingTop: 6 }}>
                    <b>{r.name}</b> <Badge kind={statusKind(r.status)}>{r.status}</Badge>
                    <div className="muted" style={{ fontSize: 11 }}>
                      {r.reason ? r.reason : `${HORIZON_LABEL[r.horizon] || r.horizon} · ${r.metrics?.n ?? 0} trades · expectancy ${n2(r.metrics?.expectancy_pct)}% · PF ${n2(r.metrics?.profit_factor)} · ${r.metrics?.robust ? 'robust' : 'not robust out-of-sample'}`}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </Card>
        )}
      </div>

      <Card title={`Runs (${runs.length})`} right={<button onClick={reloadRuns}>Refresh</button>}>
        {runsLoading && !runs.length ? <div className="muted">Loading...</div> : (
          <div style={{ overflowX: 'auto' }}>
            <DataTable rows={runs} cols={runCols} initialSort={{ key: 'run_date' }} storageKey="learning-runs" empty="No learning runs yet." />
          </div>
        )}
        {shown && (
          <div className="card" style={{ background: 'rgba(255,255,255,0.02)', marginTop: 8 }}>
            <b>{shown.run_date} {shown.kind} lessons</b>
            <div className="stack" style={{ gap: 6, marginTop: 6 }}>
              {(shown.lessons || []).length ? (shown.lessons || []).map((l: any, i: number) => (
                <div key={i} style={{ fontSize: 13 }}>
                  <Badge kind="gray">{l.kind}</Badge> {l.symbol ? <Sym>{l.symbol}</Sym> : null} {l.body}
                  {l.confidence != null ? <span className="muted" style={{ fontSize: 11 }}> (confidence {l.confidence})</span> : null}
                </div>
              )) : <div className="muted">No lessons recorded for this run.</div>}
              {shown.error ? <div className="red" style={{ fontSize: 12 }}>{shown.error}</div> : null}
            </div>
          </div>
        )}
      </Card>

      <Card
        title={`Ideas (${ideas.length})`}
        right={(
          <span className="row" style={{ gap: 6 }}>
            <select value={filter} onChange={(e) => setFilter(e.target.value)} aria-label="Filter ideas by status">
              <option value="">all</option>
              <option value="kept">kept</option>
              <option value="rejected">rejected</option>
              <option value="retired">retired</option>
            </select>
            <button onClick={reloadIdeas}>Refresh</button>
          </span>
        )}
      >
        {ideasLoading && !ideas.length ? <div className="muted">Loading...</div> : (
          <div style={{ overflowX: 'auto' }}>
            <DataTable rows={ideas} cols={ideaCols} initialSort={{ key: 'generation' }} storageKey="learning-ideas" empty="No ideas yet. Run the iterator after a session to generate the first generation." />
          </div>
        )}
      </Card>
    </div>
  );
}
