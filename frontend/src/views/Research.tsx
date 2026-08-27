import { useState } from 'react';
import { Research, RunResearch, AnalyzeSymbol, News, ResearchNotes, Earnings } from '../api/client';
import { Card, Badge, useAsync, num } from '../components/ui';

function J(v: any, d: any) { if (v == null) return d; if (typeof v === 'object') return v; try { return JSON.parse(v); } catch { return d; } }

export default function ResearchView() {
  const hist = useAsync<any[]>(() => Research(), [], 0);
  const notes = useAsync<any[]>(() => ResearchNotes(), [], 0);
  const earnings = useAsync<any[]>(() => Earnings(), [], 0);
  const [symbol, setSymbol] = useState('');
  const [stats, setStats] = useState<any>(null);
  const [news, setNews] = useState<any[]>([]);
  const [thesis, setThesis] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const [aiBusy, setAiBusy] = useState(false);
  const [err, setErr] = useState('');

  const analyze = async () => {
    if (!symbol) return;
    setBusy(true); setErr(''); setThesis(null);
    try {
      const [a, n] = await Promise.all([AnalyzeSymbol(symbol, 90), News(symbol)]);
      if (a?.error) setErr('No market data — is Alpaca configured?');
      setStats(a?.error ? null : a);
      setNews(n || []);
    } finally { setBusy(false); }
  };

  const runClaude = async () => {
    setAiBusy(true); setErr('');
    try { setThesis(await RunResearch(symbol)); hist.reload(); }
    catch (e: any) { setErr(String(e).includes('ANTHROPIC') ? 'No AI provider set — add KIMI_API_KEY in .env (real analysis, never fabricated).' : String(e)); }
    finally { setAiBusy(false); }
  };

  return (
    <div className="grid" style={{ gap: 14 }}>
      {(earnings.data || []).length > 0 && (
        <Card title="Upcoming earnings & catalysts (web-researched)">
          <table>
            <thead><tr><th>Symbol</th><th>Period</th><th>Date</th><th>Status</th><th>Latest result / notes</th></tr></thead>
            <tbody>
              {(earnings.data || []).map((e) => (
                <tr key={e.id}>
                  <td><b>{e.symbol}</b></td>
                  <td>{e.period_label}</td>
                  <td>{e.report_date} {e.confirmed ? <Badge kind="green">confirmed</Badge> : <Badge kind="amber">est</Badge>}</td>
                  <td><span className="pill">{e.status}</span></td>
                  <td className="muted" style={{ fontSize: 11, maxWidth: 420 }}>{e.transcript_summary} {e.source_url && <a href={e.source_url} target="_blank" rel="noreferrer">src</a>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}

      {(notes.data || []).length > 0 && (
        <Card title="My research desk (independent — web + your live data)">
          {(notes.data || []).map((n) => (
            <div key={n.id} className="card" style={{ background: 'var(--panel2)', marginBottom: 10 }}>
              <div className="row" style={{ justifyContent: 'space-between' }}>
                <b>{n.symbol} — {n.title}</b>
                <span className="row" style={{ gap: 6 }}>
                  <Badge kind={n.stance === 'bullish' ? 'green' : n.stance === 'bearish' ? 'red' : 'gray'}>{n.stance}</Badge>
                  <Badge kind={n.trend === 'up' ? 'green' : n.trend === 'down' ? 'red' : 'gray'}>{n.trend}</Badge>
                  <span className="pill">{n.horizon}</span>
                </span>
              </div>
              <div style={{ marginTop: 6 }}>{n.analysis}</div>
              <div className="muted" style={{ marginTop: 6, fontSize: 12 }}><b>Catalysts:</b> {(J(n.catalysts, []) as string[]).join(' · ')}</div>
              <div style={{ marginTop: 4, fontSize: 12 }}><b className="muted">Recommended:</b> {n.recommended_strategy}</div>
              <div className="row" style={{ marginTop: 6, gap: 6 }}>{(J(n.sources, []) as any[]).map((s, i) => <a key={i} href={s.url} target="_blank" rel="noreferrer" className="pill">{s.label}</a>)}</div>
            </div>
          ))}
        </Card>
      )}

      <Card title="Research — live symbol lookup">
        <div className="row">
          <input placeholder="Symbol (e.g. AMD)" value={symbol} onChange={(e) => setSymbol(e.target.value.toUpperCase())} />
          <button className="primary" onClick={analyze} disabled={busy || !symbol}>{busy ? 'Loading…' : 'Analyze (real 3-mo data)'}</button>
          {stats && <button onClick={runClaude} disabled={aiBusy}>{aiBusy ? 'AI…' : 'Add AI thesis'}</button>}
          {err && <span className="red" style={{ fontSize: 12 }}>{err}</span>}
        </div>
      </Card>

      {stats && (
        <Card title={`${stats.symbol} — last 3 months (Alpaca)`}>
          <div className="grid cols-4" style={{ gap: 10 }}>
            <div><div className="muted">Last</div><div className="stat small">${stats.last}</div></div>
            <div><div className="muted">3-mo return</div><div className={`stat small ${stats.period_return_pct >= 0 ? 'green' : 'red'}`}>{stats.period_return_pct}%</div></div>
            <div><div className="muted">Annualized vol</div><div className="stat small">{stats.annualized_vol_pct}%</div></div>
            <div><div className="muted">Trend</div><div><Badge kind={stats.trend === 'up' ? 'green' : stats.trend === 'down' ? 'red' : 'gray'}>{stats.trend}</Badge></div></div>
          </div>
          <div className="row" style={{ marginTop: 10, gap: 16, fontSize: 12 }}>
            <span className="muted">max gain <span className="green">{stats.max_gain_pct}%</span></span>
            <span className="muted">max drawdown <span className="red">{stats.max_drawdown_pct}%</span></span>
            <span className="muted">60d high ${stats.high} / low ${stats.low}</span>
            <span className="muted">avg daily range {stats.avg_daily_range_pct}%</span>
            <span className="muted">up days {stats.up_days_pct}%</span>
            <span className="muted">RSI {num(stats.indicators?.rsi14, 0)}</span>
            <span className="muted">SMA20 ${num(stats.indicators?.sma20, 2)}</span>
          </div>
          <div className="muted" style={{ marginTop: 8 }}>{stats.note}</div>
        </Card>
      )}

      {thesis && (
        <Card title="AI thesis">
          <div className="row" style={{ gap: 6, marginBottom: 6 }}>
            <Badge kind={Number(thesis.sentiment) > 0 ? 'green' : Number(thesis.sentiment) < 0 ? 'red' : 'gray'}>sentiment {num(thesis.sentiment)}</Badge>
            <Badge kind="blue">conviction {num(thesis.conviction)}</Badge>
            <Badge kind="amber">{thesis.suggested_action}</Badge>
          </div>
          <div>{thesis.thesis}</div>
        </Card>
      )}

      {stats && (
        <Card title={`Recent ${stats.symbol} news (real)`}>
          {news.length === 0 ? <div className="muted">No stored news for {stats.symbol} yet — hit Refresh on the News page.</div> :
            news.slice(0, 8).map((n) => (
              <div key={n.id} style={{ padding: '6px 0', borderBottom: '1px solid var(--border)' }}>
                <div>{n.headline}</div>
                <div className="muted" style={{ fontSize: 11 }}>{n.source} · {n.published_at ? new Date(n.published_at).toLocaleString('en-US', { timeZone: 'America/Los_Angeles' }) : ''} {n.url && <a href={n.url} target="_blank" rel="noreferrer">· read →</a>}</div>
              </div>
            ))}
        </Card>
      )}
    </div>
  );
}
