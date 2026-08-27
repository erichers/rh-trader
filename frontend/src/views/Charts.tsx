import { useEffect, useState } from 'react';
import TradingViewChart from '../components/TradingViewChart';
import { AnalyzeSymbol, ResearchNotes, Earnings, EarningsDocs, Watchlist, AddWatch } from '../api/client';
import { Card, Badge, num } from '../components/ui';
import { Icon } from '../components/icons';
import BotWizard, { type BotPreset } from '../components/BotWizard';

const FAVS = ['QQQ', 'SPY', 'TSLA', 'META', 'MSFT', 'AMD', 'NVDA'];

type Rec = { label: string; why: string; tag: string; kind: string; bot: any };

function recommend(symbol: string, s: any): Rec[] {
  const recs: Rec[] = [];
  const base = (extra: any) => ({ symbols: [symbol], enabled: 0, mode: 'observe', ai_gate: { enabled: false }, risk: {}, ...extra });
  const opt = (option_type: string, strike: string, exp: string, tf = '1Day') =>
    ({ side: 'buy', qty: 1, order_type: 'market', option_type, strike_target: strike, expiration: exp, _category: 'options-' + (option_type === 'call' ? 'calls' : 'puts'), _timeframe: tf });
  const rsi = s?.indicators?.rsi14;
  const trend = s?.trend;
  const vol = s?.annualized_vol_pct ?? 0;

  if (rsi != null && rsi < 32) recs.push({ label: 'Oversold Bounce — Long Call', tag: 'call', kind: 'green', why: `RSI ${rsi.toFixed(0)} is oversold — mean-reversion bounce setup.`, bot: base({ name: `${symbol} Oversold Bounce — Long Call`, asset_class: 'option', rules: { rsi_below: 32, min_matches: 1 }, action: opt('call', 'atm', 'weekly') }) });
  if (rsi != null && rsi > 68) recs.push({ label: 'Overbought Fade — Long Put', tag: 'put', kind: 'red', why: `RSI ${rsi.toFixed(0)} is overbought — fade setup.`, bot: base({ name: `${symbol} Overbought Fade — Long Put`, asset_class: 'option', rules: { rsi_above: 68, bollinger_upper: true, min_matches: 1 }, action: opt('put', 'otm', 'monthly') }) });
  if (trend === 'up') {
    recs.push({ label: vol > 40 ? 'Trend-Pullback — Long Call (high vol)' : 'Breakout — Long Call', tag: 'call', kind: 'green', why: `Uptrend (${s.period_return_pct}% 3-mo). ${vol > 40 ? 'High vol favors leveraged calls on pullbacks.' : 'Buy strength on breakouts.'}`, bot: base({ name: `${symbol} ${vol > 40 ? 'Trend-Pullback' : 'Breakout'} — Long Call`, asset_class: 'option', rules: vol > 40 ? { ema_cross: true, price_above_sma20: true, min_matches: 1 } : { breakout_high: true }, action: opt('call', vol > 40 ? 'otm' : 'otm', 'monthly') }) });
    recs.push({ label: 'Trend Follower — Equity', tag: 'equity', kind: 'blue', why: 'Stay long while trend + momentum agree.', bot: base({ name: `${symbol} Trend Follower`, asset_class: 'equity', rules: { price_above_sma20: true, macd_positive: true, require_all: true }, action: { side: 'buy', qty: 1, order_type: 'market' } }) });
  }
  if (trend === 'down') recs.push({ label: 'Downtrend Continuation — Long Put', tag: 'put', kind: 'red', why: `Downtrend (${s.period_return_pct}% 3-mo). Fade bounces into resistance.`, bot: base({ name: `${symbol} Downtrend — Long Put`, asset_class: 'option', rules: { bollinger_upper: true, rsi_above: 50, min_matches: 1 }, action: opt('put', 'otm', 'monthly') }) });
  if (trend === 'sideways' && vol > 30) {
    recs.push({ label: 'Range Fade — Long Put', tag: 'put', kind: 'red', why: `Range-bound + high vol (${vol}%). Fade the top of the range.`, bot: base({ name: `${symbol} Range Fade — Long Put`, asset_class: 'option', rules: { bollinger_upper: true, rsi_above: 60, min_matches: 1 }, action: opt('put', 'atm', 'weekly') }) });
    recs.push({ label: 'Range Reclaim — Long Call', tag: 'call', kind: 'green', why: 'Buy reclaims off the bottom of the range.', bot: base({ name: `${symbol} Range Reclaim — Long Call`, asset_class: 'option', rules: { bollinger_lower: true }, action: opt('call', 'atm', 'weekly', '5m') }) });
  }
  recs.push({ label: 'RSI Bounce — Equity', tag: 'equity', kind: 'blue', why: 'Conservative equity dip-buy in an uptrend.', bot: base({ name: `${symbol} RSI Bounce`, asset_class: 'equity', rules: { rsi_below: 35, price_above_sma20: true, min_matches: 1 }, action: { side: 'buy', qty: 1, order_type: 'market' } }) });
  return recs;
}

export default function ChartsView() {
  const [symbol, setSymbol] = useState('AMD');
  const [stats, setStats] = useState<any>(null);
  const [note, setNote] = useState<any>(null);
  const [earn, setEarn] = useState<any[]>([]);
  const [docs, setDocs] = useState<any[]>([]);
  const [wl, setWl] = useState<string[]>([]);
  const [wizard, setWizard] = useState<BotPreset | null>(null);

  const load = async (sym: string) => {
    setStats(null); setNote(null); setEarn([]); setDocs([]);
    const [a, n, e, d] = await Promise.all([
      AnalyzeSymbol(sym, 90).catch(() => null), ResearchNotes(sym).catch(() => []),
      Earnings(sym).catch(() => []), EarningsDocs(sym).catch(() => []),
    ]);
    setStats(a && !a.error ? a : null);
    setNote((n || [])[0] || null);
    setEarn(e || []);
    setDocs(d || []);
  };
  useEffect(() => { load(symbol); Watchlist().then((w: any[]) => setWl(w.map((x) => x.symbol))).catch(() => {}); }, [symbol]);

  const recs = stats ? recommend(symbol, stats) : [];
  const J = (v: any, d: any) => { if (v == null) return d; if (typeof v === 'object') return v; try { return JSON.parse(v); } catch { return d; } };

  return (
    <div className="grid" style={{ gap: 14 }}>
      <Card title="Charts & Explore">
        <div className="row" style={{ gap: 6 }}>
          {FAVS.map((f) => <button key={f} className={symbol === f ? 'primary' : ''} onClick={() => setSymbol(f)}>{f}</button>)}
          <input placeholder="Ticker" style={{ width: 90 }} onKeyDown={(e: any) => { if (e.key === 'Enter' && e.target.value) setSymbol(e.target.value.toUpperCase()); }} />
          {!wl.includes(symbol) && <button onClick={async () => { await AddWatch(symbol); setWl([...wl, symbol]); }}>+ watchlist</button>}
        </div>
      </Card>

      <Card title={`${symbol} — TradingView (live)`}>
        <TradingViewChart symbol={symbol} height={500} />
      </Card>

      {stats && (
        <Card title={`${symbol} — 3-month snapshot (Alpaca)`}>
          <div className="row" style={{ gap: 16, fontSize: 13 }}>
            <span>last <b>${stats.last}</b></span>
            <span className={stats.period_return_pct >= 0 ? 'green' : 'red'}>3-mo {stats.period_return_pct}%</span>
            <span className="muted">vol {stats.annualized_vol_pct}%</span>
            <span className="muted">maxGain <span className="green">{stats.max_gain_pct}%</span></span>
            <span className="muted">maxDD <span className="red">{stats.max_drawdown_pct}%</span></span>
            <Badge kind={stats.trend === 'up' ? 'green' : stats.trend === 'down' ? 'red' : 'gray'}>{stats.trend}</Badge>
            <span className="muted">RSI {num(stats.indicators?.rsi14, 0)}</span>
          </div>
        </Card>
      )}

      {note && (
        <Card title={`My research — ${note.title}`} right={<Badge kind={note.stance === 'bullish' ? 'green' : note.stance === 'bearish' ? 'red' : 'gray'}>{note.stance}</Badge>}>
          <div>{note.analysis}</div>
          <div style={{ marginTop: 8 }}><b className="muted">Catalysts:</b> {(J(note.catalysts, []) as string[]).join(' · ')}</div>
          <div style={{ marginTop: 6 }}><b className="muted">Recommended:</b> {note.recommended_strategy}</div>
          <div className="row" style={{ marginTop: 6, gap: 8 }}>
            {(J(note.sources, []) as any[]).map((s, i) => <a key={i} href={s.url} target="_blank" rel="noreferrer" className="pill">{s.label}</a>)}
          </div>
        </Card>
      )}

      {earn.length > 0 && (
        <Card title="Earnings & catalysts">
          <table>
            <thead><tr><th>Period</th><th>Date</th><th>Status</th><th>Est</th><th>Notes</th></tr></thead>
            <tbody>
              {earn.map((e) => (
                <tr key={e.id}>
                  <td><b>{e.period_label}</b></td>
                  <td>{e.report_date} {e.confirmed ? <Badge kind="green">confirmed</Badge> : <Badge kind="amber">est</Badge>}</td>
                  <td><span className="pill">{e.status}</span></td>
                  <td>{e.eps_estimate}</td>
                  <td className="muted" style={{ fontSize: 11, maxWidth: 360 }}>{e.transcript_summary} {e.source_url && <a href={e.source_url} target="_blank" rel="noreferrer">src</a>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}

      {docs.length > 0 && (
        <Card title={`${symbol} — earnings decks & transcripts`}>
          <div className="muted" style={{ marginBottom: 8, fontSize: 12 }}>
            Investor-relations archives hold all quarterly decks/transcripts. Recent quarters are analyzed below; open the archive for the full 8-quarter history.
          </div>
          {docs.map((d) => (
            <div key={d.id} style={{ padding: '8px 0', borderBottom: '1px solid var(--border)' }}>
              <div className="row" style={{ justifyContent: 'space-between' }}>
                <span><b>{d.period_label === 'ALL' ? <span className="icon-btn"><Icon name="library" size={14} /> Full archive</span> : d.period_label === 'TRANSCRIPTS' ? <span className="icon-btn"><Icon name="journal" size={14} /> Transcripts</span> : d.period_label}</b> <span className="pill">{d.doc_type}</span> {d.analyzed ? <Badge kind="green">analyzed</Badge> : null}</span>
                <a href={d.url} target="_blank" rel="noreferrer">open →</a>
              </div>
              <div className="muted" style={{ fontSize: 12, marginTop: 2 }}>{d.title}</div>
              {d.summary && <div style={{ marginTop: 4, fontSize: 13 }}>{d.summary}</div>}
              {d.key_points && (() => { const kp = J(d.key_points, []); return kp.length ? <div className="row" style={{ gap: 6, marginTop: 6 }}>{(kp as string[]).map((k, i) => <span key={i} className="pill">{k}</span>)}</div> : null; })()}
            </div>
          ))}
        </Card>
      )}

      <Card title={`Recommended strategies for ${symbol}`}>
        <div className="muted" style={{ marginBottom: 10, fontSize: 12 }}>Matched to {symbol}'s current regime. One click creates a bot (disabled, Observe) — tune it on the Bots page.</div>
        <div className="grid cols-2">
          {recs.map((r, i) => (
            <div key={i} className="card" style={{ background: 'var(--panel2)' }}>
              <div className="row" style={{ justifyContent: 'space-between' }}>
                <b>{r.label}</b><Badge kind={r.kind}>{r.tag}</Badge>
              </div>
              <div className="muted" style={{ marginTop: 6, fontSize: 12 }}>{r.why}</div>
              <button className="primary" style={{ marginTop: 8 }}
                onClick={() => setWizard({ name: r.bot.name, symbols: r.bot.symbols, asset_class: r.bot.asset_class, rules: r.bot.rules, action: r.bot.action })}>
                + Add bot
              </button>
            </div>
          ))}
        </div>
      </Card>

      {wizard && <BotWizard preset={wizard} onClose={() => setWizard(null)} onCreated={() => setWizard(null)} />}
    </div>
  );
}
