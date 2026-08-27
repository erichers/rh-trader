import { useEffect, useState } from 'react';
import { Bots, RunBacktest, ScanStrategies, Regime } from '../api/client';
import { Card, Badge, useAsync, money, Info, Sym } from '../components/ui';
import { Icon } from '../components/icons';
import { PriceChart, EquityChart } from '../components/svgcharts';
import BotWizard, { type BotPreset } from '../components/BotWizard';

const BADGE_STYLE: Record<string, { kind: string; label: React.ReactNode }> = {
  '100x': { kind: 'gold', label: <span className="icon-btn"><Icon name="growth" size={13} /> 100×</span> },
  '10x': { kind: 'gold', label: '10×' },
  '5x': { kind: 'green', label: '5×' },
  '2x': { kind: 'green', label: '2×' },
  'high-win': { kind: 'blue', label: 'high-win' },
  profitable: { kind: 'gray', label: 'profitable' },
  'small-sample': { kind: 'amber', label: <span className="icon-btn"><Icon name="warning" size={13} /> small sample</span> },
  'modeled-only': { kind: 'amber', label: <span className="icon-btn"><Icon name="warning" size={13} /> modeled (not real-priced)</span> },
  'seasonal-fit': { kind: 'green', label: <span className="icon-btn"><Icon name="check" size={13} /> fits now</span> },
  'regime-neutral': { kind: 'gray', label: 'regime-neutral' },
  'regime-caution': { kind: 'amber', label: <span className="icon-btn"><Icon name="warning" size={13} /> regime-caution</span> },
};
function BadgeRow({ badges }: { badges: string[] }) {
  return <>{(badges || []).map((b) => { const s = BADGE_STYLE[b]; return s ? <Badge key={b} kind={s.kind}>{s.label}</Badge> : null; })}</>;
}

const FAVS = ['AMD', 'NVDA', 'TSLA', 'META', 'MSFT', 'QQQ', 'SPY', 'AAPL'];
const STAKE = 1000;
const iso = (d: Date) => d.toISOString().slice(0, 10);
const daysAgo = (n: number) => iso(new Date(Date.now() - n * 864e5));

function J(v: any, d: any) { try { return typeof v === 'string' ? JSON.parse(v) : (v ?? d); } catch { return d; } }

function suggestion(m: any, r: any): string {
  if (!m || !m.num_trades) return 'No trades fired in this window — try a wider date range or a different ticker/strategy.';
  const bits: string[] = [];
  bits.push(m.total_return_pct >= 0 ? `Net positive (+${m.total_return_pct}% on $1k)` : `Net negative (${m.total_return_pct}% on $1k)`);
  bits.push(`${m.win_rate}% win rate over ${m.num_trades} trades`);
  if (m.trades_2x > 0) bits.push(`${m.trades_2x} trade(s) hit ≥2× (best ${m.best_multiple}×)`);
  if (r?.asset_class === 'option') bits.push('options modeled (leverage + theta) — size small, defined risk');
  if (m.win_rate >= 60 && m.total_return_pct > 0) bits.push('looks robust here — consider Cautious mode to trade it with approvals');
  else if (m.total_return_pct < 0) bits.push('underperformed in this regime — keep in Observe');
  return bits.join(' · ');
}

export default function BacktestView() {
  const bots = useAsync<any[]>(Bots, []);
  const [botId, setBotId] = useState<number | 'adhoc'>('adhoc');
  const [symbol, setSymbol] = useState('AMD');
  const [from, setFrom] = useState(daysAgo(120));
  const [to, setTo] = useState(iso(new Date()));
  const [res, setRes] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [wizard, setWizard] = useState<BotPreset | null>(null);
  const [realOpt, setRealOpt] = useState(true);

  // server-side strategy scan (badges + seasonal fit + account multiple)
  const [scan, setScan] = useState<any>(null);
  const [scanning, setScanning] = useState(false);
  const regime = useAsync<any>(Regime, []);

  const list = bots.data || [];
  const selectedBot = list.find((b) => b.id === botId);
  const botSymbols: string[] = selectedBot ? J(selectedBot.symbols, []) : [];

  // When picking a bot, default the ticker to its first symbol.
  useEffect(() => { if (selectedBot && botSymbols.length) setSymbol(String(botSymbols[0]).toUpperCase()); }, [botId]);

  const run = async () => {
    setBusy(true); setErr(''); setRes(null);
    try {
      const body: any = { symbol, from, to, realOptions: realOpt };
      if (botId !== 'adhoc') body.bot_id = botId;
      else body.rules = { rsi_below: 35, price_above_sma20: true, min_matches: 1 };
      const r = await RunBacktest(body);
      setRes(r);
    } catch (e: any) { setErr(String(e)); }
    finally { setBusy(false); }
  };

  const runScan = async () => {
    setScanning(true);
    try { setScan(await ScanStrategies(182)); } catch (e: any) { setErr(String(e)); }
    finally { setScanning(false); }
  };

  const m = res?.metrics;
  const net = m ? STAKE * (1 + m.total_return_pct / 100) : STAKE;

  return (
    <div className="grid" style={{ gap: 14 }}>
      <Card title="Backtest workspace">
        <div className="row" style={{ gap: 10, flexWrap: 'wrap' }}>
          <label className="muted">Strategy
            <select value={String(botId)} onChange={(e) => setBotId(e.target.value === 'adhoc' ? 'adhoc' : Number(e.target.value))} style={{ marginLeft: 6, minWidth: 200 }}>
              <option value="adhoc">— ad-hoc (RSI dip) —</option>
              {list.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
            </select>
          </label>
          <label className="muted">Ticker
            <input value={symbol} onChange={(e) => setSymbol(e.target.value.toUpperCase())} style={{ width: 80, marginLeft: 6 }} />
          </label>
          <label className="muted">From <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} style={{ marginLeft: 4 }} /></label>
          <label className="muted">To <input type="date" value={to} onChange={(e) => setTo(e.target.value)} style={{ marginLeft: 4 }} /></label>
          <button className="primary" onClick={run} disabled={busy || !symbol}>{busy ? 'Running…' : 'Run backtest'}</button>
          <label className="row" title="For option strategies, price each trade with REAL historical option bars where Alpaca has them (else modeled).">
            <input type="checkbox" checked={realOpt} onChange={(e) => setRealOpt(e.target.checked)} /> real option prices
          </label>
        </div>
        <div className="row" style={{ gap: 6, marginTop: 8 }}>
          <span className="muted" style={{ fontSize: 11 }}>Range:</span>
          {[30, 90, 180, 365].map((d) => <button key={d} onClick={() => { setFrom(daysAgo(d)); setTo(iso(new Date())); }}>{d}d</button>)}
          <span className="muted" style={{ fontSize: 11, marginLeft: 8 }}>Ticker:</span>
          {[...new Set([...botSymbols.map((s) => String(s).toUpperCase()), ...FAVS])].slice(0, 9).map((s) => (
            <button key={s} className={symbol === s ? 'primary' : ''} onClick={() => setSymbol(s)}>{s}</button>
          ))}
        </div>
        {err && <div className="red" style={{ marginTop: 8 }}>{err}</div>}
      </Card>

      {res && m && (
        <>
          <div className="grid cols-4">
            <Card title="Net on $1k"><div className={`stat ${net >= STAKE ? 'green' : 'red'}`}>{money(net)}</div></Card>
            <Card title="Total return"><div className={`stat small ${m.total_return_pct >= 0 ? 'green' : 'red'}`}>{m.total_return_pct >= 0 ? '+' : ''}{m.total_return_pct}%</div></Card>
            <Card title="Win rate"><div className="stat small">{m.win_rate}% <span className="muted" style={{ fontSize: 12 }}>({m.num_trades})</span></div></Card>
            <Card title="Best trade"><div className="stat small green">{m.best_multiple}× <span className="muted" style={{ fontSize: 12 }}>≥2×: {m.trades_2x}</span></div></Card>
          </div>

          <Card title={`${res.symbol} — price & trades (${res.from} → ${res.to})`}>
            <PriceChart series={res.series} trades={res.trades} height={320} />
            <div className="row" style={{ gap: 14, marginTop: 6, fontSize: 11 }} >
              <span className="muted"><span style={{ color: 'var(--green)' }}>●</span> entry / winning exit</span>
              <span className="muted"><span style={{ color: 'var(--red)' }}>●</span> losing exit</span>
              <span className="muted">{res.notes}</span>
            </div>
          </Card>

          <Card title="Equity curve (fixed $1k stake per trade)" right={
            <button className="primary" onClick={() => setWizard({ symbols: [res.symbol], asset_class: res.asset_class, ...(selectedBot ? { name: `${selectedBot.name} (${res.symbol})`, rules: J(selectedBot.rules, undefined), action: J(selectedBot.action, undefined) } : {}) })}>
              + Create bot from this
            </button>
          }>
            <EquityChart curve={res.equity_curve} dates={res.equity_dates} height={180} />
            <div className="muted" style={{ marginTop: 6 }}>{suggestion(m, res)}</div>
          </Card>

          <Card title={`Trades (${res.trades.length})`}>
            {res.trades.length === 0 ? <div className="muted">No trades in this window.</div> : (
              <table>
                <thead><tr><th>Entry</th><th>Exit</th><th>Held</th><th>{res.asset_class === 'option' ? 'Opt in/out $' : 'Entry/Exit $'}</th><th>Underlying</th><th>Return</th><th>×</th><th>Src</th><th>Why exit</th></tr></thead>
                <tbody>
                  {res.trades.map((t: any, i: number) => (
                    <tr key={i}>
                      <td>{t.entry_date}</td><td>{t.exit_date}</td><td>{t.bars}d</td>
                      <td>{t.option_entry != null ? `$${t.option_entry} → $${t.option_exit}` : `$${t.entry} → $${t.exit}`}</td>
                      <td className={t.underlyingRet >= 0 ? 'green' : 'red'}>{t.underlyingRet >= 0 ? '+' : ''}{t.underlyingRet}%</td>
                      <td className={t.ret >= 0 ? 'green' : 'red'}><b>{t.ret >= 0 ? '+' : ''}{t.ret}%</b></td>
                      <td>{t.multiple}×</td>
                      <td>{t.source === 'real' ? <Badge kind="green">real</Badge> : t.source === 'modeled' ? <span className="muted" style={{ fontSize: 11 }}>modeled</span> : '—'}</td>
                      <td className="muted" style={{ fontSize: 11 }}>{t.reason}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Card>
        </>
      )}

      <Card
        title={<>Strategy scan — find 10×–100× bots (6 months)<Info topic="scan" /></>}
        right={<button className="primary" onClick={runScan} disabled={scanning}>{scanning ? 'Scanning all bots…' : 'Scan all strategies'}</button>}
      >
        {regime.data && (
          <div className="muted" style={{ fontSize: 12, marginBottom: 8 }}>
            Current regime <Info topic="seasonal_fit" />: <b>{regime.data.label}</b>. Bots are badged by how they backtested AND whether they fit this regime now.
          </div>
        )}
        {!scan ? (
          <div className="muted">Backtests every bot over the last 6 months (option bots priced with real historical chains), ranks by compounded account multiple, and badges the winners + their fit to the current regime.</div>
        ) : (
          <>
            <div className="row" style={{ gap: 8, marginBottom: 10, flexWrap: 'wrap' }}>
              <Badge kind="gold">{scan.winners_10x} bot(s) ≥ 10×</Badge>
              <Badge kind="green">{scan.seasonal_fit} fit the current regime</Badge>
              <span className="muted" style={{ fontSize: 11 }}>{scan.count} bots scanned over {scan.days}d</span>
            </div>
            <table>
              <thead><tr>
                <th>Bot</th><th>Symbols</th><th>Type</th>
                <th>Account ×<Info topic="account_multiple" /></th>
                <th>Win %</th><th>Trades</th><th>Best ×<Info topic="best_multiple" /></th><th>Badges</th><th></th>
              </tr></thead>
              <tbody>
                {scan.results.map((r: any) => {
                  const am = Number(r.account_multiple || 0);
                  const hot = am >= 10;
                  return (
                    <tr key={r.bot_id} style={hot ? { background: 'rgba(245,176,65,.08)' } : undefined}
                        title={r.seasonal?.reasons?.join(' · ')}>
                      <td><b>{r.name}</b>{r.error && <span className="red icon-btn" style={{ fontSize: 11 }}> <Icon name="warning" size={12} /> {r.error}</span>}</td>
                      <td className="muted">{(r.symbols || []).map((s: string, i: number) => <span key={s}>{i ? ' ' : ''}<Sym>{s}</Sym></span>)}</td>
                      <td><span className="pill">{r.asset_class}</span></td>
                      <td className={am >= 2 ? 'green' : am < 1 ? 'red' : ''}><b>{am}×</b></td>
                      <td>{r.win_rate}%</td>
                      <td>{r.num_trades}</td>
                      <td>{r.best_multiple}×</td>
                      <td><div className="row" style={{ gap: 3, flexWrap: 'wrap' }}><BadgeRow badges={r.badges} /></div></td>
                      <td><button onClick={() => { const b = list.find((x) => x.id === r.bot_id); if (b) { setBotId(b.id); setSymbol(String((r.symbols || ['SPY'])[0])); window.scrollTo({ top: 0, behavior: 'smooth' }); } }}>open</button></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <div className="muted" style={{ fontSize: 11, marginTop: 8 }}>
              Account × is compounded (reinvest everything each trade) — the realistic upper bound for an all-in high-risk run. Hover a row for why it fits/doesn't fit the regime.
            </div>
          </>
        )}
      </Card>

      {wizard && <BotWizard preset={wizard} onClose={() => setWizard(null)} onCreated={() => { setWizard(null); bots.reload(); }} />}
    </div>
  );
}
