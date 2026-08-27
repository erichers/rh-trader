import { useState } from 'react';
import { Watchlist, AddWatch, DelWatch, AnalyzeSymbol } from '../api/client';
import { Card, Badge, useAsync, Sym, money } from '../components/ui';

export default function WatchlistView() {
  const { data, reload } = useAsync<any[]>(Watchlist, []);
  const [sym, setSym] = useState('');
  const [analysis, setAnalysis] = useState<Record<string, any>>({});
  const [loading, setLoading] = useState<Record<string, boolean>>({});

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

  return (
    <div className="grid" style={{ gap: 14 }}>
      <Card title={`Watchlist (${(data || []).length})`} right={<button onClick={analyzeAll}>Analyze all (3-mo)</button>}>
        <div className="row" style={{ marginBottom: 10 }}>
          <input placeholder="Add symbol" value={sym} onChange={(e) => setSym(e.target.value.toUpperCase())} style={{ width: 120 }} />
          <button className="primary" onClick={async () => { if (sym) { await AddWatch(sym); setSym(''); reload(); } }}>Add</button>
        </div>
        <table>
          <thead><tr><th>Symbol</th><th>Note</th><th>Last</th><th>3-mo</th><th>Vol</th><th>MaxGain</th><th>MaxDD</th><th>Trend</th><th>RSI</th><th></th></tr></thead>
          <tbody>
            {(data || []).length === 0 && <tr><td colSpan={10} className="muted">Watchlist is empty — add a symbol above (e.g. NVDA, SPY).</td></tr>}
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
