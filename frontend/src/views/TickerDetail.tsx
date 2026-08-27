import { useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { Ticker, AddWatch, DelWatch } from '../api/client';
import { Card, Badge, money, num, pct, signClass, useAsync, posLast } from '../components/ui';
import TradingViewChart from '../components/TradingViewChart';
import BotWizard, { type BotPreset } from '../components/BotWizard';

function bn(v: any): string {
  const n = Number(v);
  if (!Number.isFinite(n) || n === 0) return '—';
  if (Math.abs(n) >= 1e12) return `$${(n / 1e12).toFixed(2)}T`;
  if (Math.abs(n) >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
  if (Math.abs(n) >= 1e6) return `$${(n / 1e6).toFixed(1)}M`;
  return money(n);
}

export default function TickerDetail() {
  const { symbol = '' } = useParams();
  const sym = symbol.toUpperCase();
  const nav = useNavigate();
  const { data, loading, reload } = useAsync<any>(() => Ticker(sym), [sym], 12000);
  const [wizard, setWizard] = useState<BotPreset | null>(null);

  if (loading && !data) return <Card><div className="muted">Loading {sym}…</div></Card>;
  const q = data?.quote || {};
  const f = data?.fundamentals;
  const stats = data?.stats;
  const up = Number(q.changePct) >= 0;

  // Crypto is TRACKED as a macro indicator only — never traded. Hide all trade/bot
  // actions for crypto symbols so the page can't contradict the no-crypto guardrail.
  const isCrypto = /^(BTC|ETH|SOL|DOGE|XRP|ADA|BNB)(-?USD)?$/.test(sym);
  const newBot = () => setWizard({ name: `${sym} bot`, symbols: [sym], asset_class: 'equity', mode: 'observe' });
  const newOptBot = (type: 'call' | 'put') => setWizard({ name: `${sym} ${type} bot`, symbols: [sym], asset_class: 'option', action: { option_type: type, strike_target: 'atm', expiration: 'monthly' }, mode: 'observe' });

  return (
    <div className="grid" style={{ gap: 14 }}>
      {/* ── Quote header ──────────────────────────────────────────────── */}
      <Card>
        <div className="row" style={{ justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: 10 }}>
          <div>
            <div className="row" style={{ gap: 8, alignItems: 'baseline' }}>
              <h2 style={{ margin: 0 }}>{sym}</h2>
              {data?.hasOptions && <Badge kind="blue">options</Badge>}
              {data?.onWatchlist && <Badge kind="amber">watchlist</Badge>}
              <span className="muted" style={{ fontSize: 12 }}>via {q.source}</span>
            </div>
            <div className="row" style={{ gap: 10, alignItems: 'baseline', marginTop: 4 }}>
              <span className="stat" style={{ fontSize: 30 }}>{money(q.price)}</span>
              <span className={`${signClass(q.change)}`} style={{ fontSize: 16 }}>
                {q.change != null ? `${up ? '+' : ''}${num(q.change)} (${pct(q.changePct)})` : ''}
              </span>
            </div>
            <div className="muted" style={{ fontSize: 12, marginTop: 2 }}>
              Bid {money(q.bid)} · Ask {money(q.ask)} · Prev close {money(q.prevClose)}
            </div>
          </div>
          <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
            {isCrypto ? (
              <Badge kind="amber">tracked as indicator — not traded</Badge>
            ) : (
              <>
                <button onClick={() => nav(`/options?symbol=${sym}`)}>Options chain →</button>
                <button onClick={newBot}>+ Equity bot</button>
                <button onClick={() => newOptBot('call')}>+ Call bot</button>
                <button onClick={() => newOptBot('put')}>+ Put bot</button>
              </>
            )}
            {data?.onWatchlist
              ? <button onClick={() => DelWatch(sym).then(reload)}>− Watchlist</button>
              : <button onClick={() => AddWatch(sym).then(reload)}>+ Watchlist</button>}
          </div>
        </div>
      </Card>

      <div className="grid cols-2" style={{ alignItems: 'start' }}>
        <Card title="Chart"><TradingViewChart symbol={sym} height={420} /></Card>

        <div className="grid" style={{ gap: 14 }}>
          {/* Fundamentals (Robinhood) */}
          <Card title="Fundamentals">
            {!f ? <div className="muted" style={{ fontSize: 13 }}>Connect Robinhood for fundamentals (market cap, P/E, 52-wk range, sector…).</div> : (
              <div className="grid cols-2" style={{ gap: 6, fontSize: 13 }}>
                <KV k="Market cap" v={bn(f.market_cap)} />
                <KV k="P/E" v={num(f.pe_ratio)} />
                <KV k="52-wk high" v={money(f.high_52w)} />
                <KV k="52-wk low" v={money(f.low_52w)} />
                <KV k="Avg volume" v={f.avg_volume ? Number(f.avg_volume).toLocaleString() : '—'} />
                <KV k="Div yield" v={f.dividend_yield ? `${num(f.dividend_yield)}%` : '—'} />
                <KV k="Sector" v={f.sector || '—'} />
                <KV k="Industry" v={f.industry || '—'} />
              </div>
            )}
          </Card>

          {/* 3-month stats (Alpaca) */}
          {stats && (
            <Card title="3-month stats">
              <div className="grid cols-2" style={{ gap: 6, fontSize: 13 }}>
                <KV k="Return (90d)" v={pct(stats.return_pct ?? stats.changePct)} />
                <KV k="Volatility" v={stats.volatility_pct != null ? `${num(stats.volatility_pct)}%` : '—'} />
                <KV k="RSI(14)" v={num(stats.rsi ?? stats.rsi14, 0)} />
                <KV k="vs SMA200" v={stats.sma200 ? pct(((Number(q.price) - Number(stats.sma200)) / Number(stats.sma200)) * 100) : '—'} />
              </div>
            </Card>
          )}
        </div>
      </div>

      {/* ── Your positions / bots in this name ────────────────────────── */}
      <div className="grid cols-2" style={{ alignItems: 'start' }}>
        <Card title={`Your position${(data?.positions || []).length === 1 ? '' : 's'} in ${sym}`}>
          {(data?.positions || []).length === 0 ? <div className="muted">No open position.</div> : (
            <table>
              <thead><tr><th>Qty</th><th>Avg cost</th><th>Current</th><th>Value</th><th>P/L</th></tr></thead>
              <tbody>
                {data.positions.map((p: any) => {
                  const last = posLast(p);
                  return (
                    <tr key={p.id}>
                      <td>{num(p.qty)}</td><td>{money(p.avg_cost)}</td>
                      <td>{last != null ? money(last) : '—'}</td><td>{money(p.market_value)}</td>
                      <td className={signClass(p.unrealized_pl)}>{money(p.unrealized_pl)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </Card>

        <Card title={`Bots trading ${sym}`} right={<a href="#/bots">all bots →</a>}>
          {(data?.bots || []).length === 0 ? <div className="muted">No bots reference {sym}. <a href="#" onClick={(e) => { e.preventDefault(); newBot(); }}>Create one →</a></div> : (
            <table>
              <thead><tr><th>Bot</th><th>Type</th><th>Mode</th><th>State</th></tr></thead>
              <tbody>
                {data.bots.map((b: any) => (
                  <tr key={b.id} style={{ cursor: 'pointer' }} onClick={() => nav('/bots')}>
                    <td><b>{b.name}</b></td>
                    <td><span className="pill">{b.asset_class}</span></td>
                    <td><span className="pill">{b.mode}</span></td>
                    <td>{b.enabled ? <Badge kind="green">enabled</Badge> : <Badge kind="gray">off</Badge>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
      </div>

      {/* ── Research / earnings / news ────────────────────────────────── */}
      {(data?.notes || []).length > 0 && (
        <Card title="Research notes" right={<a href="#/research">research desk →</a>}>
          {data.notes.map((nNote: any) => (
            <div key={nNote.id} style={{ padding: '6px 0', borderTop: '1px solid var(--border)' }}>
              <b>{nNote.title}</b> {nNote.stance && <Badge kind={nNote.stance === 'bullish' ? 'green' : nNote.stance === 'bearish' ? 'red' : 'gray'}>{nNote.stance}</Badge>}
              <div className="muted" style={{ fontSize: 12 }}>{String(nNote.analysis || '').slice(0, 240)}…</div>
            </div>
          ))}
        </Card>
      )}

      {(data?.earnings || []).length > 0 && (
        <Card title="Earnings">
          <table>
            <thead><tr><th>Period</th><th>Date</th><th>EPS est</th><th>EPS actual</th><th>Status</th></tr></thead>
            <tbody>
              {data.earnings.map((e: any) => (
                <tr key={e.id}><td>{e.period_label}</td><td>{e.report_date ? new Date(e.report_date).toLocaleDateString() : '—'}</td><td>{e.eps_estimate || '—'}</td><td>{e.eps_actual || '—'}</td><td><span className="pill">{e.status}</span></td></tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}

      {(data?.news || []).length > 0 && (
        <Card title="Recent news" right={<a href="#/news">all news →</a>}>
          {data.news.map((nw: any) => (
            <div key={nw.id} style={{ padding: '5px 0', borderTop: '1px solid var(--border)' }}>
              <a href={nw.url} target="_blank" rel="noreferrer">{nw.headline}</a>
              <span className="muted" style={{ fontSize: 11, marginLeft: 6 }}>{nw.source} · {nw.published_at ? new Date(nw.published_at).toLocaleDateString() : ''}</span>
            </div>
          ))}
        </Card>
      )}

      {wizard && <BotWizard preset={wizard} onClose={() => setWizard(null)} onCreated={() => { setWizard(null); reload(); }} />}
    </div>
  );
}

function KV({ k, v }: { k: string; v: any }) {
  return <div className="row" style={{ justifyContent: 'space-between' }}><span className="muted">{k}</span><span style={{ fontWeight: 600 }}>{v}</span></div>;
}
