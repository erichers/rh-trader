import { useState } from 'react';
import { Watchlist, AddWatch, DelWatch, AnalyzeSymbol, WatchStatus } from '../api/client';
import { Card, Badge, useAsync, Sym, money, Info } from '../components/ui';

function stanceKind(s?: string | null): string {
  if (s === 'opportunity' || s === 'up') return 'green';
  if (s === 'caution' || s === 'down') return 'red';
  return 'gray';
}

export default function WatchlistView() {
  const { data, reload } = useAsync<any[]>(Watchlist, []);
  const watch = useAsync<any>(WatchStatus, [], 15000);
  const [sym, setSym] = useState('');
  const [analysis, setAnalysis] = useState<Record<string, any>>({});
  const [loading, setLoading] = useState<Record<string, boolean>>({});
  const universe: string[] = watch.data?.universe || ['SPY', 'META', 'TSLA', 'QQQ'];
  const notes: any[] = watch.data?.lastCycle?.symbols || [];

  const analyze = async (s: string) => {
    setLoading((l) => ({ ...l, [s]: true }));
    try {
      const r = await AnalyzeSymbol(s, 90);
      setAnalysis((a) => ({ ...a, [s]: r }));
    } catch (e: any) {
      setAnalysis((a) => ({ ...a, [s]: { error: String(e) } }));
    } finally { setLoading((l) => ({ ...l, [s]: false })); }
  };
  const analyzeAll = () => (data || []).forEach((w) => analyze(w.symbol));

  const row = (w: any) => {
    const a = analysis[w.symbol];
    const take = notes.find((n) => n.symbol === w.symbol);
    return { a, take };
  };

  return (
    <div className="grid" style={{ gap: 14 }}>
      <Card title={<>Desk watcher<Info topic="watcher" /></>} right={<span className="pill">Observe only</span>}>
        <p className="muted" style={{ fontSize: 13, margin: '0 0 8px' }}>
          Muse loops {universe.join(', ')} for news plus simple indicators. It writes alerts and notes.
          It does not place orders. Extra tickers below are for charts; the watcher stays on that universe.
        </p>
        <div className="watch-uni">
          {(notes.length ? notes : universe.map((s) => ({ symbol: s }))).map((s: any) => (
            <div key={s.symbol} className="watch-uni-card">
              <div className="row" style={{ justifyContent: 'space-between', gap: 6 }}>
                <Sym bold>{s.symbol}</Sym>
                <Badge kind={stanceKind(s.stance || s.trend)}>{s.stance || s.trend || 'queued'}</Badge>
              </div>
              <div className="muse-v muted">{s.note || s.error || 'Waiting on the next cycle.'}</div>
            </div>
          ))}
        </div>
        {watch.data?.lastCycle && (
          <div className="muted" style={{ fontSize: 11, marginTop: 8 }}>
            last cycle {new Date(watch.data.lastCycle.at).toLocaleString('en-US', { timeZone: 'America/Los_Angeles', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })} PT
          </div>
        )}
      </Card>
      <Card title={`Watchlist (${(data || []).length})`} right={<button onClick={analyzeAll}>Analyze all (3-mo)</button>}>
        <div className="row" style={{ marginBottom: 10 }}>
          <input placeholder="Add symbol" value={sym} onChange={(e) => setSym(e.target.value.toUpperCase())} style={{ width: 120 }} />
          <button className="primary" onClick={async () => { if (sym) { await AddWatch(sym); setSym(''); reload(); } }}>Add</button>
        </div>

        <div className="watch-cards">
          {(data || []).length === 0 && <div className="muted">Empty. The desk defaults to SPY, META, TSLA, and QQQ. Add one of those, or wait for the next boot seed.</div>}
          {(data || []).map((w) => {
            const { a, take } = row(w);
            return (
              <div key={w.symbol} className="watch-card">
                <div className="row" style={{ justifyContent: 'space-between' }}>
                  <Sym bold>{w.symbol}</Sym>
                  <button className="danger" onClick={async () => { await DelWatch(w.symbol); reload(); }}>Remove</button>
                </div>
                {w.note && <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>{w.note}</div>}
                {take?.note && <div className="muse-v" style={{ marginTop: 6 }}>{take.note}</div>}
                {a && !a.error ? (
                  <div className="watch-card-figs">
                    <div><div className="muse-k">Last</div><b>{money(a.last)}</b></div>
                    <div><div className="muse-k">3-mo</div><b className={a.period_return_pct >= 0 ? 'green' : 'red'}>{a.period_return_pct}%</b></div>
                    <div><div className="muse-k">Trend</div><Badge kind={a.trend === 'up' ? 'green' : a.trend === 'down' ? 'red' : 'gray'}>{a.trend}</Badge></div>
                    <div><div className="muse-k">Vol</div><b>{a.annualized_vol_pct}%</b></div>
                    <div><div className="muse-k">RSI</div><b>{a.indicators?.rsi14?.toFixed(0)}</b></div>
                    <div><div className="muse-k">Max DD</div><b className="red">{a.max_drawdown_pct}%</b></div>
                  </div>
                ) : (
                  <div style={{ marginTop: 8 }}>
                    {loading[w.symbol] ? <span className="muted">analyzing…</span> : a?.error
                      ? <span className="red">{String(a.error).slice(0, 80)} <button onClick={() => analyze(w.symbol)}>retry</button></span>
                      : <button onClick={() => analyze(w.symbol)}>Analyze 3-mo</button>}
                  </div>
                )}
              </div>
            );
          })}
        </div>

        <table className="watch-table">
          <thead><tr><th>Symbol</th><th>Note</th><th>Last</th><th>3-mo</th><th>Vol</th><th>MaxGain</th><th>MaxDD</th><th>Trend</th><th>RSI</th><th></th></tr></thead>
          <tbody>
            {(data || []).length === 0 && <tr><td colSpan={10} className="muted">Empty. The desk defaults to SPY, META, TSLA, and QQQ. Add one of those, or wait for the next boot seed.</td></tr>}
            {(data || []).map((w) => {
              const a = analysis[w.symbol];
              return (
                <tr key={w.symbol}>
                  <td><Sym bold>{w.symbol}</Sym></td>
                  <td className="muted" style={{ fontSize: 11 }}>{w.note}</td>
                  {a && !a.error ? (
                    <>
                      <td>{money(a.last)}</td>
                      <td className={a.period_return_pct >= 0 ? 'green' : 'red'}>{a.period_return_pct}%</td>
                      <td>{a.annualized_vol_pct}%</td>
                      <td className="green">{a.max_gain_pct}%</td>
                      <td className="red">{a.max_drawdown_pct}%</td>
                      <td><Badge kind={a.trend === 'up' ? 'green' : a.trend === 'down' ? 'red' : 'gray'}>{a.trend}</Badge></td>
                      <td>{a.indicators?.rsi14?.toFixed(0)}</td>
                    </>
                  ) : (
                    <td colSpan={7} className="muted">{loading[w.symbol] ? 'analyzing…' : a?.error ? <span className="red">{String(a.error).slice(0, 80)} <button onClick={() => analyze(w.symbol)}>retry</button></span> : <button onClick={() => analyze(w.symbol)}>Analyze 3-mo</button>}</td>
                  )}
                  <td><button className="danger" onClick={async () => { await DelWatch(w.symbol); reload(); }}>×</button></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </Card>
    </div>
  );
}
