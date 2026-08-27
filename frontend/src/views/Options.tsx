import { useEffect, useState, type CSSProperties } from 'react';
import { useSearchParams } from 'react-router-dom';
import { OptChain } from '../api/client';
import { Card, Badge, money, Info } from '../components/ui';
import BotWizard, { type BotPreset } from '../components/BotWizard';

const FAVS = ['SPY', 'QQQ', 'NVDA', 'MU', 'AMD', 'TSLA', 'CEG', 'META'];

function targetFor(strike: number, spot: number, type: 'call' | 'put'): 'atm' | 'otm' | 'itm' {
  if (!spot || Math.abs(strike - spot) / spot < 0.02) return 'atm';
  if (type === 'call') return strike > spot ? 'otm' : 'itm';
  return strike < spot ? 'otm' : 'itm';
}
function fmtExp(x: string): string {
  const d = new Date(x + 'T00:00:00');
  const dte = Math.round((d.getTime() - Date.now()) / 864e5);
  return `${d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} · ${dte}d`;
}
const g = (v: any, d = 2) => (v == null || !Number.isFinite(Number(v)) ? '—' : Number(v).toFixed(d));
const ivp = (v: any) => (v == null || !Number.isFinite(Number(v)) ? '—' : `${(Number(v) * 100).toFixed(0)}%`);

export default function OptionsView() {
  const [params] = useSearchParams();
  const [symbol, setSymbol] = useState((params.get('symbol') || 'SPY').toUpperCase());
  const [chain, setChain] = useState<any>(null);
  const [exp, setExp] = useState('');
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState('');
  const [side, setSide] = useState<'both' | 'call' | 'put'>('both');
  const [wizard, setWizard] = useState<BotPreset | null>(null);

  const load = async (sym: string, expiration?: string) => {
    setLoading(true); setErr('');
    try {
      const c = await OptChain(sym, expiration);
      if (c.error) { setErr(c.message || 'no options data'); setChain(null); }
      else { setChain(c); setExp(c.expiration); }
    } catch (e: any) { setErr(String(e)); setChain(null); }
    finally { setLoading(false); }
  };
  useEffect(() => { load(symbol); }, [symbol]);

  const spot = chain?.spot || 0;
  const strikes = chain ? [...new Set([...chain.calls, ...chain.puts].map((c: any) => c.strike))].sort((a, b) => a - b) : [];
  const callBy: Record<number, any> = {}; const putBy: Record<number, any> = {};
  chain?.calls.forEach((c: any) => (callBy[c.strike] = c));
  chain?.puts.forEach((p: any) => (putBy[p.strike] = p));
  const atmIdx = strikes.reduce((best, s, i) => (Math.abs(s - spot) < Math.abs(strikes[best] - spot) ? i : best), 0);
  const view = strikes.slice(Math.max(0, atmIdx - 14), atmIdx + 15);
  const step = strikes.length > 1 ? strikes[1] - strikes[0] : 1;

  const expDate = exp ? new Date(exp + 'T00:00:00') : null;
  const expPref = expDate && (expDate.getTime() - Date.now()) / 864e5 <= 9 ? 'weekly' : 'monthly';
  const addBot = (strike: number, type: 'call' | 'put') => setWizard({
    name: `${symbol} ${strike} ${type} (${exp})`,
    symbols: [symbol], asset_class: 'option', mode: 'observe',
    action: { option_type: type, strike_target: targetFor(strike, spot, type), expiration: expPref },
  });

  // breakeven + % move helpers for the selected single-side ladder
  const beCall = (s: number, mid: number) => (mid ? s + mid : null);
  const bePut = (s: number, mid: number) => (mid ? s - mid : null);

  return (
    <div className="grid" style={{ gap: 14 }}>
      <Card title="Options Chain">
        <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
          {FAVS.map((f) => <button key={f} className={symbol === f ? 'primary' : ''} onClick={() => setSymbol(f)}>{f}</button>)}
          <input placeholder="Ticker" style={{ width: 80 }} onKeyDown={(e: any) => e.key === 'Enter' && e.target.value && setSymbol(e.target.value.toUpperCase())} />
          {chain && <span className="muted">spot <b>{money(spot)}</b></span>}
          <a href={`#/ticker/${symbol}`} style={{ marginLeft: 'auto' }}>{symbol} detail →</a>
        </div>
        {/* Expiration pills */}
        {chain && (
          <div className="row" style={{ gap: 4, marginTop: 8, flexWrap: 'wrap' }}>
            {chain.expirations.map((x: string) => (
              <button key={x} className={x === exp ? 'primary' : ''} style={{ fontSize: 11, padding: '3px 8px' }} onClick={() => { setExp(x); load(symbol, x); }}>{fmtExp(x)}</button>
            ))}
          </div>
        )}
        {/* Side toggle */}
        <div className="row" style={{ gap: 4, marginTop: 8 }}>
          {(['both', 'call', 'put'] as const).map((s) => (
            <button key={s} className={side === s ? 'primary' : ''} style={{ fontSize: 11, padding: '3px 10px' }} onClick={() => setSide(s)}>{s === 'both' ? 'Calls + Puts' : s === 'call' ? 'Calls' : 'Puts'}</button>
          ))}
        </div>
        <div className="muted" style={{ fontSize: 11, marginTop: 6 }}>
          Live bid/ask/mid, last, open interest + greeks (Δ)<Info topic="greeks" /> and implied vol from Alpaca options snapshots. ITM rows shaded<Info topic="itm" />. Click a strike to build a bot from it.
        </div>
        {err && <div className="red" style={{ marginTop: 8 }}>{err}</div>}
      </Card>

      {loading && <Card><div className="muted">Loading chain…</div></Card>}

      {chain && !loading && side === 'both' && (
        <Card title={`${symbol} — ${exp}`}>
          <div className="opt-chain">
            <table>
              <thead>
                <tr>
                  <th colSpan={6} style={{ textAlign: 'center', color: 'var(--green)' }}>CALLS</th>
                  <th style={{ textAlign: 'center' }}>Strike</th>
                  <th colSpan={6} style={{ textAlign: 'center', color: 'var(--red)' }}>PUTS</th>
                </tr>
                <tr style={{ fontSize: 11 }}>
                  <th>IV</th><th>Δ</th><th>Bid</th><th>Ask</th><th>OI</th><th></th>
                  <th style={{ textAlign: 'center' }}>$</th>
                  <th></th><th>Bid</th><th>Ask</th><th>OI</th><th>Δ</th><th>IV</th>
                </tr>
              </thead>
              <tbody>
                {view.map((s) => {
                  const c = callBy[s]; const p = putBy[s];
                  const atm = Math.abs(s - spot) < step * 0.6;
                  const callItm = spot && s < spot, putItm = spot && s > spot;
                  return (
                    <tr key={s} style={atm ? { background: 'rgba(255,255,255,.06)' } : undefined}>
                      <td className="muted" style={callItm ? itm : undefined}>{ivp(c?.iv)}</td>
                      <td className="muted" style={callItm ? itm : undefined}>{g(c?.delta)}</td>
                      <td style={callItm ? itm : undefined}>{g(c?.bid)}</td>
                      <td style={callItm ? itm : undefined}>{g(c?.ask)}</td>
                      <td className="muted" style={callItm ? itm : undefined}>{c?.open_interest ?? '—'}</td>
                      <td>{c && <button style={mini} onClick={() => addBot(s, 'call')}>+</button>}</td>
                      <td style={{ textAlign: 'center', fontWeight: 700 }}>{s}{atm && <Badge kind="gray">ATM</Badge>}</td>
                      <td>{p && <button style={mini} onClick={() => addBot(s, 'put')}>+</button>}</td>
                      <td style={putItm ? itm : undefined}>{g(p?.bid)}</td>
                      <td style={putItm ? itm : undefined}>{g(p?.ask)}</td>
                      <td className="muted" style={putItm ? itm : undefined}>{p?.open_interest ?? '—'}</td>
                      <td className="muted" style={putItm ? itm : undefined}>{g(p?.delta)}</td>
                      <td className="muted" style={putItm ? itm : undefined}>{ivp(p?.iv)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      {chain && !loading && side !== 'both' && (
        <Card title={`${symbol} ${side === 'call' ? 'Calls' : 'Puts'} — ${exp}`}>
          <table>
            <thead><tr><th>Strike</th><th>Moneyness</th><th>Bid</th><th>Ask</th><th>Mid</th><th>Last</th><th>Δ</th><th>IV</th><th>OI</th><th>Breakeven</th><th></th></tr></thead>
            <tbody>
              {view.map((s) => {
                const o = side === 'call' ? callBy[s] : putBy[s];
                if (!o) return null;
                const itmRow = side === 'call' ? (spot && s < spot) : (spot && s > spot);
                const be = side === 'call' ? beCall(s, o.mid) : bePut(s, o.mid);
                const tgt = targetFor(s, spot, side);
                return (
                  <tr key={s} style={itmRow ? { background: 'rgba(255,255,255,.04)' } : undefined}>
                    <td style={{ fontWeight: 700 }}>{s}</td>
                    <td><Badge kind={tgt === 'itm' ? 'green' : tgt === 'atm' ? 'gray' : 'blue'}>{tgt.toUpperCase()}</Badge></td>
                    <td>{g(o.bid)}</td><td>{g(o.ask)}</td><td><b>{g(o.mid)}</b></td><td>{g(o.last)}</td>
                    <td className="muted">{g(o.delta)}</td><td className="muted">{ivp(o.iv)}</td><td className="muted">{o.open_interest ?? '—'}</td>
                    <td className="muted">{be ? money(be) : '—'}</td>
                    <td><button style={mini} onClick={() => addBot(s, side)}>+ bot</button></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </Card>
      )}

      {wizard && <BotWizard preset={wizard} onClose={() => setWizard(null)} onCreated={() => setWizard(null)} />}
    </div>
  );
}

const itm: CSSProperties = { background: 'rgba(0,208,156,.07)' };
const mini: CSSProperties = { fontSize: 11, padding: '1px 7px' };
