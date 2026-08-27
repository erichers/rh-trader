import { useState } from 'react';
import { Ticker, FocusBrain, LearnTicker, Futures, NewsSearch, Focus as FocusApi, SetFocus, RiskLimits } from '../api/client';
import { Card, Badge, money, num, pct, signClass, useAsync, Sym, Info, Live, posLast } from '../components/ui';
import { EquityChart } from '../components/svgcharts';
import TradingViewChart from '../components/TradingViewChart';
import BotWizard, { type BotPreset } from '../components/BotWizard';
import { Icon } from '../components/icons';

function scoreColor(s: number) { return s >= 66 ? 'green' : s >= 40 ? 'amber' : 'red'; }

export default function FocusView() {
  const focus = useAsync<any>(FocusApi, [], 0);
  const sym = (focus.data?.symbol || 'SPY').toUpperCase();
  const enabled = !!focus.data?.enabled;
  const tickers: string[] = focus.data?.tickers || ['SPY', 'QQQ', 'NVDA', 'MU', 'AMD', 'TSLA', 'META', 'MSFT', 'AAPL', 'CEG'];

  const data = useAsync<any>(() => Ticker(sym), [sym], 8000);
  const brain = useAsync<any>(() => FocusBrain(sym), [sym], 30000);
  const fut = useAsync<any>(Futures, [], 30000);
  const limits = useAsync<any>(RiskLimits, [], 0);
  const [learning, setLearning] = useState(false);
  const [wizard, setWizard] = useState<BotPreset | null>(null);
  const [q, setQ] = useState('');
  const [hits, setHits] = useState<any[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [err, setErr] = useState('');

  const quote = data.data?.quote || {};
  const latest = brain.data?.latest || null;
  const score = latest ? Number(latest.performance_score) : null;
  const scoreTrend: number[] = brain.data?.scoreTrend || [];
  const leadFut = (fut.data?.futures || []).find((f: any) => f.proxy === sym) || null;

  const learn = async () => { setLearning(true); try { await LearnTicker(sym); await brain.reload(); } catch (e: any) { setErr(String(e)); } finally { setLearning(false); } };
  const search = async () => {
    if (!q.trim()) { setHits(null); setErr(''); return; }
    setSearching(true); setErr('');
    try { const r = await NewsSearch(q, sym); setHits(r.results || []); }
    catch (e: any) { setErr('Search failed: ' + String(e)); setHits([]); }
    finally { setSearching(false); }
  };
  // Changing the inspected ticker preserves the current on/off state (doesn't force focus ON).
  const switchSym = async (s: string) => { await SetFocus(enabled, s).catch(() => {}); focus.reload(); };

  return (
    <div className="grid" style={{ gap: 14 }}>
      {/* ── Focus header ──────────────────────────────────────────────── */}
      <Card>
        <div className="row" style={{ justifyContent: 'space-between', flexWrap: 'wrap', gap: 10 }}>
          <div className="row" style={{ gap: 10, alignItems: 'baseline', flexWrap: 'wrap' }}>
            <h2 style={{ margin: 0 }} className="icon-btn"><Icon name="focus" size={20} /> Focus</h2>
            <select aria-label="Focus ticker" value={sym} onChange={(e) => switchSym(e.target.value)} style={{ fontSize: 16, fontWeight: 700 }}>
              {[...new Set([sym, ...tickers])].map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
            <span className="stat" style={{ fontSize: 24 }}>{money(quote.price)}</span>
            <span className={signClass(quote.change)} style={{ fontSize: 15 }}>{quote.change != null ? `${quote.change >= 0 ? '+' : ''}${num(quote.change)} (${pct(quote.changePct)})` : ''}</span>
            <span className="muted" style={{ fontSize: 11 }}>via {quote.source}</span>
            <Live />
          </div>
          <div className="row" style={{ gap: 6 }}>
            {!enabled
              ? <button className="primary" onClick={() => SetFocus(true, sym).then(focus.reload)}>Enter focus mode</button>
              : <Badge kind="green">FOCUS ON · all bots trade {sym}</Badge>}
            <button onClick={() => (window.location.hash = `#/ticker/${sym}`)}>Full ticker page →</button>
          </div>
        </div>
        {enabled && (
          <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>
            While focus is on, the worker concentrates every enabled bot on <b>{sym}</b> and the AI learns it each cycle. Toggle off in the header to restore all bots.
            {limits.data?.limits && (
              <> · Concentration cap: <b>{limits.data.limits.maxConcentrationPct}%</b> of equity per name — <a href="#/settings">adjust →</a>
                {limits.data.limits.maxConcentrationPct < 50 && <span className="amber"> (raise it to go heavy on one ticker)</span>}
              </>
            )}
          </div>
        )}
      </Card>

      <div className="grid cols-2" style={{ alignItems: 'start' }}>
        {/* ── The AI brain (self-improving score) ─────────────────────── */}
        <Card title={<span className="icon-btn"><Icon name="research" size={16} /> AI read — learns every cycle<Info text="Groq scores how tradable the ticker looks right now from real chart stats + the system's own recent signals/fills + news; material reads escalate to Kimi for a deeper lesson. Every read is stored, so the per-ticker brain compounds over time." /></span>}
          right={<button onClick={learn} disabled={learning}>{learning ? 'Learning…' : 'Learn now'}</button>}>
          {!latest ? (
            <div className="muted">No reads yet. Click “Learn now” (or enable focus) — the system will score {sym} and start compounding lessons.</div>
          ) : (
            <>
              <div className="row" style={{ gap: 14, alignItems: 'baseline' }}>
                <div className={`stat ${scoreColor(score || 0)}`} style={{ fontSize: 40 }}>{score ?? '—'}</div>
                <div>
                  <div className="muted" style={{ fontSize: 11 }}>performance score / 100</div>
                  {latest.trend && <Badge kind={latest.trend === 'up' ? 'green' : latest.trend === 'down' ? 'red' : 'gray'}>{latest.trend}</Badge>}
                  <span className="pill" style={{ marginLeft: 6 }}>{latest.source}</span>
                </div>
                {scoreTrend.length > 1 && <div style={{ flex: 1, minWidth: 120 }}><EquityChart curve={scoreTrend} height={60} unit="" /></div>}
              </div>
              <div style={{ marginTop: 8, lineHeight: 1.5 }}>{latest.summary}</div>
              {latest.lesson && (
                <div style={{ marginTop: 8, padding: '8px 10px', borderRadius: 7, background: 'rgba(0,208,156,.06)', border: '1px solid rgba(0,208,156,.25)' }}>
                  <b className="green">Lesson (Kimi):</b> {latest.lesson}
                </div>
              )}
              <div className="muted" style={{ fontSize: 11, marginTop: 6 }}>{brain.data?.history?.length || 0} reads stored · learns ~every 40 min while focus is on</div>
            </>
          )}
        </Card>

        {/* ── Leading future + indicators ─────────────────────────────── */}
        <Card title={<span className="icon-btn"><Icon name="chart" size={16} /> Indicators — futures & macro<Info text="Index futures (ES→SPY, NQ→QQQ) lead the cash market, especially overnight. Crypto (BTC/ETH) is TRACKED as a risk-appetite indicator only — never traded (the risk engine hard-blocks crypto orders)." /></span>}
          right={fut.data?.overnight ? <Badge kind="amber">overnight session</Badge> : <Badge kind="green">regular hours</Badge>}>
          {leadFut && (
            <div style={{ marginBottom: 8, padding: '8px 10px', borderRadius: 7, background: 'rgba(74,163,255,.08)', border: '1px solid rgba(74,163,255,.25)' }}>
              <b>{leadFut.name}</b> leads <b>{sym}</b>: {money(leadFut.price)} <span className={signClass(leadFut.changePct)}>({pct(leadFut.changePct)})</span>
              <div className="muted" style={{ fontSize: 11 }}>A green future overnight points to a higher {sym} open (not a guarantee).</div>
            </div>
          )}
          <table>
            <thead><tr><th>Indicator</th><th>Leads</th><th>Price</th><th>Chg</th></tr></thead>
            <tbody>
              {(fut.data?.futures || []).map((f: any) => (
                <tr key={f.future}>
                  <td>{f.name}{f.stale && <span className="amber" style={{ fontSize: 10 }} title="last quote &gt;20m old"> ·stale</span>}</td>
                  <td><Sym>{f.proxy}</Sym></td>
                  <td>{f.ok ? money(f.price) : <span className="muted">no data</span>}</td>
                  <td className={signClass(f.changePct)}>{pct(f.changePct)}</td>
                </tr>
              ))}
              {(fut.data?.crypto || []).map((c: any) => (
                <tr key={c.symbol}>
                  <td>{c.name} <span className="muted" style={{ fontSize: 10 }}>(indicator)</span></td>
                  <td className="muted" title="tracked, never traded">— not traded —</td>
                  <td>{c.ok ? money(c.price) : <a href={`#/ticker/${c.symbol.replace('-USD', '')}`} className="muted">chart →</a>}</td>
                  <td className={signClass(c.changePct)}>{pct(c.changePct)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="muted" style={{ fontSize: 11, marginTop: 6 }}>
            Quotes via Yahoo (real, refreshes 30s) — may lag the live TradingView chart by a few minutes overnight. For true real-time, watch the chart below (type <b>ES1!</b>/<b>NQ1!</b> or <b>BTCUSD</b>).
          </div>
        </Card>
      </div>

      {/* ── Chart ─────────────────────────────────────────────────────── */}
      <Card title={`${sym} chart`}>
        {leadFut && <div className="muted" style={{ fontSize: 12, marginBottom: 6 }}>Tip: type <b>{leadFut.future.replace('=F', '1!')}</b> in the chart symbol box to watch the leading future overnight.</div>}
        <TradingViewChart symbol={sym} height={460} />
      </Card>

      {/* ── News (searchable, scoped to ticker) ───────────────────────── */}
      <Card title={<>{sym} news & knowledge<Info topic="alerts" /></>} right={
        <div className="row" style={{ gap: 6 }}>
          <input aria-label={`Search ${sym} knowledge`} placeholder={`Search ${sym} knowledge…`} value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e: any) => e.key === 'Enter' && search()} style={{ width: 200 }} />
          <button onClick={search} disabled={searching}>{searching ? 'Searching…' : 'Search'}</button>
          {hits && <button onClick={() => { setQ(''); setHits(null); setErr(''); }}>clear</button>}
        </div>
      }>
        {err && <div className="red" style={{ marginBottom: 6 }}>{err}</div>}
        {(hits || data.data?.news || []).length === 0 ? (
          <div className="muted">{hits ? 'No matches.' : `No recent ${sym} news.`}</div>
        ) : (hits || data.data?.news || []).map((nw: any) => (
          <div key={nw.id} style={{ padding: '5px 0', borderTop: '1px solid var(--border)' }}>
            <a href={nw.url} target="_blank" rel="noreferrer">{nw.title || nw.headline}</a>
            {nw.source && <span className="muted" style={{ fontSize: 11, marginLeft: 6 }}>{nw.source}</span>}
            {nw.snippet && <div className="muted" style={{ fontSize: 12 }}>{nw.snippet}</div>}
          </div>
        ))}
      </Card>

      {/* ── Bots + position on this ticker ────────────────────────────── */}
      <div className="grid cols-2" style={{ alignItems: 'start' }}>
        <Card title={`Bots on ${sym}`} right={<button onClick={() => setWizard({ name: `${sym} bot`, symbols: [sym], asset_class: 'option', action: { option_type: 'call', strike_target: 'atm', expiration: 'monthly' }, mode: 'observe' })}>+ bot</button>}>
          {(data.data?.bots || []).length === 0 ? <div className="muted">No bots reference {sym} yet.</div> : (
            <table><thead><tr><th>Bot</th><th>Type</th><th>Mode</th><th>State</th></tr></thead>
              <tbody>{data.data.bots.map((b: any) => (
                <tr key={b.id} style={{ cursor: 'pointer' }} onClick={() => (window.location.hash = '#/bots')}>
                  <td><b>{b.name}</b></td><td><span className="pill">{b.asset_class}</span></td><td><span className="pill">{b.mode}</span></td>
                  <td>{b.enabled ? <Badge kind="green">on</Badge> : <Badge kind="gray">off</Badge>}</td>
                </tr>
              ))}</tbody>
            </table>
          )}
        </Card>
        <Card title={`Your ${sym} position`} right={<a href={`#/backtest`}>backtest →</a>}>
          {(data.data?.positions || []).length === 0 ? <div className="muted">No open position.</div> : data.data.positions.map((p: any) => {
            const last = posLast(p);
            return <div key={p.id} className="row" style={{ justifyContent: 'space-between' }}><span>{num(p.qty)} @ {money(p.avg_cost)} (now {last != null ? money(last) : '—'})</span><span className={signClass(p.unrealized_pl)}>{money(p.unrealized_pl)}</span></div>;
          })}
        </Card>
      </div>

      {wizard && <BotWizard preset={wizard} onClose={() => setWizard(null)} onCreated={() => { setWizard(null); data.reload(); }} />}
    </div>
  );
}
