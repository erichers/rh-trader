import { useState, useEffect } from 'react';
import { WalkForward, KellySizing, BotPromotion, PromoteBot } from '../api/client';
import { Card, Badge, money, pct, signClass, Info } from './ui';
import { DataTable, type Column } from './datatable';
import { Icon } from './icons';

// On-demand quant tooling: walk-forward overfit test, Kelly position sizing, and the paper→live
// promotion checklist. These run real backtests so they're button-triggered, not polled.

export const QUANT_UNIVERSE = ['AAPL', 'MSFT', 'GOOGL', 'AMZN', 'NVDA', 'META', 'TSLA', 'SPY', 'QQQ'];

function verdictKind(v: string): string {
  if (v.startsWith('robust')) return 'green';
  if (v.startsWith('partial')) return 'amber';
  return 'red';
}

export function WalkForwardPanel({ symbol }: { symbol: string }) {
  const [data, setData] = useState<any>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { setData(null); setErr(null); }, [symbol]);
  const run = async () => {
    setBusy(true); setErr(null);
    try { setData(await WalkForward(symbol, 365, 5)); } catch (e: any) { setErr(String(e?.message || e)); } finally { setBusy(false); }
  };
  const cols: Column<any>[] = [
    { key: 'fold', label: '#', align: 'right' },
    { key: 'picked', label: 'In-sample pick', sortable: false, render: (r) => r.picked ? <span><Badge kind={r.picked.dir === 'call' ? 'green' : 'red'}>{r.picked.dir} {r.picked.dte}d</Badge> {r.picked.label}</span> : '—' },
    { key: 'is_expectancy', label: 'IS exp.', align: 'right', render: (r) => <span className={signClass(r.is_expectancy)}>{pct(r.is_expectancy)}</span> },
    { key: 'oos_expectancy', label: 'OOS exp.', align: 'right', render: (r) => <span className={signClass(r.oos_expectancy)} title="out-of-sample expectancy on the unseen next segment">{pct(r.oos_expectancy)}</span> },
    { key: 'oos_win_rate', label: 'OOS win%', align: 'right', render: (r) => `${r.oos_win_rate}%` },
    { key: 'oos_trades', label: 'OOS n', align: 'right' },
  ];
  return (
    <Card title={<>Walk-forward <span className="muted" style={{ fontWeight: 400, fontSize: 12 }}>· {symbol}</span> <Info text="Anchored walk-forward: each fold re-optimizes on all prior data, then scores that pick on the NEXT unseen segment. Efficiency = out-of-sample ÷ in-sample expectancy — the honest overfit detector. A leaderboard 'winner' with efficiency ≤ 0 made its money purely in-sample." /></>}
      right={<button className="primary" onClick={run} disabled={busy}>{busy ? 'Running…' : data ? 'Re-run' : 'Run walk-forward'}</button>}>
      {err && <div className="red">{err}</div>}
      {!data && !err && <div className="muted">Splits the last year into folds and tests each in-sample pick on unseen data. ~10–20s.</div>}
      {data && (
        <div className="stack" style={{ gap: 10 }}>
          <div className="row" style={{ gap: 10, flexWrap: 'wrap' }}>
            <Metric label="Efficiency" value={data.efficiency} kind={data.efficiency >= 0.6 ? 'green' : data.efficiency >= 0.3 ? 'amber' : 'red'} />
            <Metric label="OOS exp. (avg)" value={pct(data.oos_avg_expectancy)} kind={signClass(data.oos_avg_expectancy)} />
            <Metric label="IS exp. (avg)" value={pct(data.is_avg_expectancy)} kind={signClass(data.is_avg_expectancy)} />
            <Metric label="OOS+ folds" value={`${data.oos_positive_folds}/${data.folds}`} />
          </div>
          <div><Badge kind={verdictKind(data.verdict)}>{data.verdict}</Badge></div>
          <DataTable rows={data.results || []} cols={cols} filter={false} initialSort={{ key: 'fold', dir: 1 }} rowKey={(r) => r.fold} />
          <div className="muted" style={{ fontSize: 11 }}>{data.notes}</div>
        </div>
      )}
    </Card>
  );
}

export function KellyPanel({ symbol }: { symbol: string }) {
  const [data, setData] = useState<any>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [equity, setEquity] = useState<string>('');
  useEffect(() => { setData(null); setErr(null); }, [symbol]);
  const run = async () => {
    setBusy(true); setErr(null);
    try { setData(await KellySizing(symbol, equity ? { equity: Number(equity) } : {})); } catch (e: any) { setErr(String(e?.message || e)); } finally { setBusy(false); }
  };
  return (
    <Card title={<>Kelly sizing <span className="muted" style={{ fontWeight: 400, fontSize: 12 }}>· {symbol}</span> <Info text="Translates the play's backtested win-rate × payoff into a Kelly-optimal capital fraction, then recommends QUARTER-Kelly (robust to a noisy/overfit edge), bounded by the risk engine's max-position cap. No positive edge ⇒ it tells you not to size up." /></>}
      right={<span className="row" style={{ gap: 4 }}><input placeholder="equity $" value={equity} onChange={(e) => setEquity(e.target.value)} style={{ width: 90 }} /><button className="primary" onClick={run} disabled={busy}>{busy ? '…' : data ? 'Re-run' : 'Size it'}</button></span>}>
      {err && <div className="red">{err}</div>}
      {!data && !err && <div className="muted">Sizes the best backtested play on {symbol} off real expectancy. ~5–15s.</div>}
      {data && (
        <div className="stack" style={{ gap: 10 }}>
          <div className="muted" style={{ fontSize: 12 }}>
            Play: <Badge kind={data.play.dir === 'call' ? 'green' : 'red'}>{data.play.dir} {data.play.dte}d</Badge> {data.play.label} {data.play.robust ? <Badge kind="green">robust</Badge> : <Badge kind="amber">in-sample</Badge>}
          </div>
          <div className="row" style={{ gap: 10, flexWrap: 'wrap' }}>
            <Metric label="Win rate" value={`${data.edge.win_rate}%`} />
            <Metric label="Payoff" value={`${data.edge.payoff_ratio}×`} />
            <Metric label="Expectancy" value={pct(data.edge.expectancy_pct)} kind={signClass(data.edge.expectancy_pct)} />
            <Metric label="Full Kelly" value={`${(data.kelly.full * 100).toFixed(1)}%`} />
          </div>
          {!data.has_edge ? (
            <div className="red icon-btn" style={{ fontSize: 13 }}><Icon name="warning" size={15} /> {data.notes}</div>
          ) : (
            <>
              <table className="dense">
                <thead><tr><th>Sizing</th><th>Fraction</th><th style={{ textAlign: 'right' }}>Deploy</th><th></th></tr></thead>
                <tbody>
                  {(data.ladder || []).map((l: any) => (
                    <tr key={l.name} style={l.name === 'Quarter Kelly' ? { background: 'rgba(34,197,94,0.08)' } : undefined}>
                      <td>{l.name}{l.name === 'Quarter Kelly' && <Badge kind="green">rec</Badge>}</td>
                      <td>{(l.frac * 100).toFixed(1)}%</td>
                      <td style={{ textAlign: 'right' }}>{money(l.deploy_usd)}</td>
                      <td className="muted" style={{ fontSize: 11 }}>{l.note}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <div className="card" style={{ background: 'rgba(34,197,94,0.06)' }}>
                <b>Recommended: deploy {money(data.recommended.deploy_usd)}</b> <span className="muted">({data.recommended.pct_equity}% of {money(data.equity)} equity)</span>
                {data.recommended.capped_by_max_position && <span className="amber"> · capped by max-position {money(data.recommended.max_position_usd)}</span>}
                {data.recommended.risk_at_stop_usd != null && <div className="muted" style={{ fontSize: 12 }}>Risk at stop: {money(data.recommended.risk_at_stop_usd)}.</div>}
                {data.vol_target && <div className="muted" style={{ fontSize: 12 }}>Vol-target alt ({data.vol_target.risk_per_trade_pct}% risk/trade @ {data.vol_target.stop_loss_pct}% stop): {money(data.vol_target.deploy_usd)}.</div>}
              </div>
            </>
          )}
          <div className="muted" style={{ fontSize: 11 }}>{data.notes}</div>
        </div>
      )}
    </Card>
  );
}

export function PromotionModal({ botId, onClose, onPromoted }: { botId: number; onClose: () => void; onPromoted?: () => void }) {
  const [data, setData] = useState<any>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(true);
  const load = async () => {
    setBusy(true); setErr(null);
    try { setData(await BotPromotion(botId)); } catch (e: any) { setErr(String(e?.message || e)); } finally { setBusy(false); }
  };
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [botId]);
  const promote = async (force: boolean) => {
    setBusy(true);
    try { const r = await PromoteBot(botId, force); setData(r); if (r.promoted) onPromoted?.(); } catch (e: any) { setErr(String(e?.message || e)); } finally { setBusy(false); }
  };
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 620 }}>
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <h2 style={{ margin: 0 }}>Promote to live {data?.bot && <span className="muted" style={{ fontSize: 14 }}>· {data.bot.name}</span>}</h2>
          <button onClick={onClose}>×</button>
        </div>
        {busy && !data && <div className="muted">Running backtest + walk-forward + paper review…</div>}
        {err && <div className="red">{err}</div>}
        {data && (
          <div className="stack" style={{ gap: 10, marginTop: 8 }}>
            <div className="row" style={{ gap: 10, alignItems: 'center' }}>
              <Badge kind={data.gate ? 'green' : 'red'}>{data.gate ? 'READY' : 'NOT READY'}</Badge>
              <div className="progress" style={{ flex: 1 }}><div className={`progress-fill ${data.gate ? 'green' : 'amber'}`} style={{ width: `${data.score}%` }} /></div>
              <span className="muted">{data.score}% · {data.passed_critical}/{data.total_critical} critical</span>
            </div>
            <div className="stack" style={{ gap: 4 }}>
              {(data.items || []).map((it: any) => (
                <div key={it.key} className="row" style={{ gap: 8, alignItems: 'flex-start' }}>
                  <span className={it.pass ? 'green' : 'red'} style={{ flex: '0 0 auto', marginTop: 1 }}><Icon name={it.pass ? 'check' : 'x'} size={15} /></span>
                  <div>
                    <div>{it.label} {it.critical && <span className="muted" style={{ fontSize: 10 }}>critical</span>}</div>
                    <div className="muted" style={{ fontSize: 11 }}>{it.detail}</div>
                  </div>
                </div>
              ))}
            </div>
            <div className={data.gate ? 'green' : 'amber'} style={{ fontSize: 13 }}>{data.recommendation}</div>
            {data.promoted && <div className="green icon-btn"><Icon name="check" size={15} /> Graduated and set to Cautious. Switch the account to Live (top bar) to deploy.</div>}
            <div className="actions">
              <button onClick={onClose}>Close</button>
              {!data.promoted && data.gate && <button className="primary" onClick={() => promote(false)} disabled={busy}>Promote → Cautious</button>}
              {!data.promoted && !data.gate && <button className="danger" onClick={() => promote(true)} disabled={busy} title="Override the gate — not recommended">Force promote</button>}
            </div>
            <div className="muted" style={{ fontSize: 11 }}>{data.notes}</div>
          </div>
        )}
      </div>
    </div>
  );
}

function Metric({ label, value, kind }: { label: string; value: React.ReactNode; kind?: string }) {
  return (
    <div className="card" style={{ flex: 1, minWidth: 88, padding: 8, textAlign: 'center' }}>
      <div className="muted" style={{ fontSize: 11 }}>{label}</div>
      <div className={kind} style={{ fontSize: 18, fontWeight: 700 }}>{value}</div>
    </div>
  );
}
