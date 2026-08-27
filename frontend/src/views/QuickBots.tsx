import { useState, useEffect } from 'react';
import { Quickbots, SeedQuickbots, QuickbotBacktest, QuickbotSignals, QuickbotResolveCheck, SetBotEnabled, SetBotMode, EvalBot, Health, ExitPolicy, SetExitPolicy, api } from '../api/client';
import { Card, Badge, FleetBadge, useAsync, money, Info, Sym } from '../components/ui';
import { Icon } from '../components/icons';
import { EquityChart } from '../components/svgcharts';
import { RiskCell } from '../components/risksizing';

const MODES = ['observe', 'cautious', 'auto', 'full_auto'];
function J(v: any, d: any) { try { return typeof v === 'string' ? JSON.parse(v) : (v ?? d); } catch { return d; } }
const pct = (n: any) => `${Number(n) >= 0 ? '+' : ''}${Number(n)}%`;
const sign = (n: any) => (Number(n) >= 0 ? 'green' : 'red');

// ── Detailed backtest panel (the "backtest tab" for a QuickBot) ────────────────
function BacktestPanel({ bot }: { bot: any }) {
  const symbols: string[] = J(bot.symbols, []);
  const [symbol, setSymbol] = useState<string>(symbols[0] || 'QQQ');
  const [days, setDays] = useState(365);
  const [bt, setBt] = useState<any>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState('');

  const run = async (sym = symbol, d = days) => {
    setLoading(true); setErr('');
    try { setBt(await QuickbotBacktest(bot.id, d, sym)); }
    catch (e: any) { setErr(String(e?.message || e)); }
    finally { setLoading(false); }
  };

  const chosenKeys = new Set((bt?.chosen || []).map((p: any) => `${p.dir}:${p.dte}:${p.key}`));
  const bestCurve = (bt?.chosen || []).slice().sort((a: any, b: any) => b.metrics.total_return_pct - a.metrics.total_return_pct)[0];
  const Row = ({ p, chosen }: { p: any; chosen?: boolean }) => {
    const m = p.metrics;
    return (
      <tr style={chosen ? { background: 'rgba(0,208,156,.06)' } : undefined}>
        <td style={{ fontSize: 12 }}>{p.label}</td>
        <td><span className={p.dir === 'call' ? 'green' : 'red'}>{p.dir}</span></td>
        <td>{p.dte}d</td>
        <td>{m.num_trades}</td>
        <td>{m.win_rate}%</td>
        <td className={sign(m.total_return_pct)}>{pct(m.total_return_pct)}</td>
        <td className={m.profit_factor >= 1 ? 'green' : 'red'}>{m.profit_factor}</td>
        <td className={sign(m.expectancy_pct)}>{pct(m.expectancy_pct)}</td>
        <td title="avg return 1st half / 2nd half of the window">{p.robust ? <Badge kind="green">robust</Badge> : <span className="muted" style={{ fontSize: 11 }}>{pct(p.oos?.h1)}/{pct(p.oos?.h2)}</span>}</td>
      </tr>
    );
  };

  return (
    <div style={{ marginTop: 10, padding: 12, borderRadius: 8, background: 'var(--panel2)' }}>
      <div className="row" style={{ justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 }}>
        <b>1-Year Backtest<Info topic="quickbot_bt" /></b>
        <div className="row" style={{ gap: 8 }}>
          {symbols.length > 1 && (
            <select value={symbol} onChange={(e) => { setSymbol(e.target.value); run(e.target.value, days); }}>
              {symbols.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
          )}
          <select value={days} onChange={(e) => { setDays(Number(e.target.value)); run(symbol, Number(e.target.value)); }}>
            <option value={365}>1 year</option><option value={180}>6 months</option><option value={90}>3 months</option><option value={730}>2 years</option>
          </select>
          <button className="primary" onClick={() => run()} disabled={loading}>{loading ? 'running…' : bt ? 'Re-run' : 'Run backtest'}</button>
        </div>
      </div>
      {err && <div className="red" style={{ marginTop: 6, fontSize: 12 }}>{err}</div>}
      {!bt && !loading && <div className="muted" style={{ marginTop: 8, fontSize: 13 }}>Run to rank every signal × DTE combination over the last year on real {symbol} price action (Black-Scholes priced, spread-costed, out-of-sample checked).</div>}

      {bt && (
        <div style={{ marginTop: 10 }}>
          <div className="muted" style={{ fontSize: 12, marginBottom: 8 }}>{bt.symbol} · {bt.from} → {bt.to} · {bt.all?.length} combinations tested</div>
          <div style={{ marginBottom: 6 }}><b className="muted">SELECTED PLAYS (what trades live on {bt.symbol})</b></div>
          <table>
            <thead><tr><th>Play</th><th>Dir</th><th>DTE</th><th>Trades</th><th>Win</th><th>Total ($1k)</th><th>PF</th><th>Avg/trade</th><th>Out-of-sample</th></tr></thead>
            <tbody>{(bt.chosen || []).map((p: any) => <Row key={`${p.dir}${p.dte}${p.key}`} p={p} chosen />)}</tbody>
          </table>

          {bestCurve && (
            <div style={{ marginTop: 10 }}>
              <div className="muted" style={{ fontSize: 12, marginBottom: 4 }}>Equity of best selected play ({bestCurve.label}, {bestCurve.dte}DTE), fixed $1,000 per trade, after costs</div>
              <EquityChart curve={bestCurve.equity_curve} height={140} unit="$" />
            </div>
          )}

          <details style={{ marginTop: 10 }}>
            <summary style={{ cursor: 'pointer', fontSize: 13 }}><b>All {bt.all?.length} combinations ranked</b> (the search behind the selection)</summary>
            <table style={{ marginTop: 6 }}>
              <thead><tr><th>Signal</th><th>Dir</th><th>DTE</th><th>Trades</th><th>Win</th><th>Total ($1k)</th><th>PF</th><th>Avg/trade</th><th>Out-of-sample</th></tr></thead>
              <tbody>{(bt.all || []).map((p: any) => <Row key={`${p.dir}${p.dte}${p.key}`} p={p} chosen={chosenKeys.has(`${p.dir}:${p.dte}:${p.key}`)} />)}</tbody>
            </table>
          </details>

          <div className="muted" style={{ fontSize: 11, marginTop: 8, lineHeight: 1.5 }}>{bt.notes}</div>
        </div>
      )}
    </div>
  );
}

// ── Plays manager: per-symbol display + inline edit + add / remove ─────────────
const bandFor = (bands: any, dte: number) => bands?.[dte] || bands?.[String(dte)] || { tp: 60, sl: 35, trail: 25, max_position_usd: 500, qty: 1 };

function PlaysManager({ bot, signals, reload }: { bot: any; signals: any; reload: () => void }) {
  const action = J(bot.action, {});
  const symbols: string[] = J(bot.symbols, []);
  const perSymbol = !!action.symbol_plays;
  const groupsInit = perSymbol
    ? symbols.map((s) => ({ symbol: s, plays: (action.symbol_plays?.[s] || []) }))
    : [{ symbol: symbols[0] || null, plays: action.plays || [] }];

  const [edit, setEdit] = useState<any[] | null>(null);
  const [msg, setMsg] = useState('');
  const cat = signals?.signals || [];
  const dtes: number[] = signals?.dtes || [2, 3, 4, 7];
  const bands = signals?.bands || {};

  const catByKey: Record<string, any> = Object.fromEntries(cat.map((c: any) => [c.key, c]));
  const paramMeta = signals?.param_meta || {};

  const addPlay = (gi: number, key: string, dte: number, rules: any) => {
    const sig = catByKey[key]; if (!sig) return;
    const b = bandFor(bands, dte);
    const play = { name: `${sig.label} · ${dte}DTE`, key: sig.key, direction: sig.dir, dte, strike_target: 'atm',
      rules: JSON.parse(JSON.stringify(rules || sig.rules)), risk: { tp: b.tp, sl: b.sl, trail: b.trail, max_position_usd: b.max_position_usd, qty: b.qty } };
    const g = [...(edit as any[])]; g[gi] = { ...g[gi], plays: [...g[gi].plays, play] }; setEdit(g);
  };
  const removePlay = (gi: number, pi: number) => { const g = [...(edit as any[])]; g[gi] = { ...g[gi], plays: g[gi].plays.filter((_: any, i: number) => i !== pi) }; setEdit(g); };
  const setRisk = (gi: number, pi: number, k: string, v: any) => { const g = [...(edit as any[])]; const plays = [...g[gi].plays]; plays[pi] = { ...plays[pi], risk: { ...plays[pi].risk, [k]: Number(v) } }; g[gi] = { ...g[gi], plays }; setEdit(g); };
  const setRule = (gi: number, pi: number, k: string, v: any) => { const g = [...(edit as any[])]; const plays = [...g[gi].plays]; plays[pi] = { ...plays[pi], rules: { ...plays[pi].rules, [k]: Number(v) } }; g[gi] = { ...g[gi], plays }; setEdit(g); };
  // The tweakable numeric thresholds present in a play's rules (intersect with metadata).
  const ruleParams = (p: any) => Object.keys(p.rules || {}).filter((k) => paramMeta[k]).map((k) => ({ key: k, value: p.rules[k], ...paramMeta[k] }));

  const save = async () => {
    try {
      const newAction: any = { ...action };
      if (perSymbol) { newAction.symbol_plays = {}; (edit as any[]).forEach((g) => { newAction.symbol_plays[g.symbol] = g.plays; }); }
      else { newAction.plays = (edit as any[])[0].plays; }
      await api.put(`/bots/${bot.id}`, { name: bot.name, enabled: bot.enabled, symbols, asset_class: 'option', rules: {}, ai_gate: J(bot.ai_gate, { enabled: false }), action: newAction, risk: J(bot.risk, {}), mode: bot.mode });
      setEdit(null); setMsg('saved'); reload();
    } catch (e: any) { setMsg('Error: ' + (e?.message || e)); }
  };

  const groups = edit || groupsInit;
  return (
    <div style={{ marginTop: 8 }}>
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <b className="muted">PLAYS{perSymbol ? ' (auto-tuned per symbol)' : ''}</b>
        {!edit ? <button onClick={() => setEdit(JSON.parse(JSON.stringify(groupsInit)))}>Edit / add plays</button>
          : <span className="row" style={{ gap: 6 }}><button className="primary" onClick={save}>Save</button><button onClick={() => setEdit(null)}>Cancel</button>{msg && <span className="muted" style={{ fontSize: 11 }}>{msg}</span>}</span>}
      </div>
      {groups.map((g: any, gi: number) => (
        <div key={g.symbol || gi} style={{ marginTop: 6, padding: '6px 8px', borderRadius: 7, background: 'rgba(255,255,255,.02)' }}>
          {perSymbol && <div style={{ marginBottom: 4 }}><Sym bold>{g.symbol}</Sym></div>}
          {g.plays.length === 0 && <div className="muted" style={{ fontSize: 12 }}>No plays{perSymbol ? ' (no robust edge found for this name)' : ''}.</div>}
          {g.plays.map((p: any, pi: number) => {
            const params = ruleParams(p);
            const explain = catByKey[p.key]?.explain;
            return (
            <div key={pi} style={{ padding: '6px 0', borderTop: pi ? '1px solid rgba(255,255,255,.05)' : undefined }}>
              <div className="row" style={{ justifyContent: 'space-between', gap: 8, fontSize: 13, flexWrap: 'wrap' }}>
                <span>
                  <Badge kind={p.direction === 'call' ? 'green' : 'red'}>{p.direction}</Badge> <b>{p.dte}DTE</b> {String(p.name).replace(/^[\u{1F300}-\u{1FAFF}]\s*/u, '').replace(/ · .*/, '')}
                  {p.robust ? <Badge kind="green">robust</Badge> : p.backtest ? <Badge kind="amber">in-sample only</Badge> : null}
                  {p.backtest && <span className="muted" style={{ fontSize: 11 }}> PF {p.backtest.profit_factor} · {p.backtest.win_rate}% win · {p.backtest.num_trades} trades</span>}
                </span>
                {!edit ? <span className="muted" style={{ fontSize: 12 }}>{params.map((pr: any) => `${pr.key}=${p.rules[pr.key]}`).join(', ')}{params.length ? ' · ' : ''}TP {p.risk.tp}% / SL {p.risk.sl}% / trail {p.risk.trail}% · ≤{money(p.risk.max_position_usd)} · {p.risk.qty}x</span>
                  : <button className="danger" onClick={() => removePlay(gi, pi)}>× remove</button>}
              </div>
              {/* Trigger explanation — always shown so you understand what fires it. */}
              {explain && <div className="muted" style={{ fontSize: 11, marginTop: 2, lineHeight: 1.4 }}>{explain}</div>}
              {/* Edit mode: tweak the trigger threshold(s) + the DTE-scaled risk. */}
              {edit && (
                <div className="row" style={{ gap: 10, marginTop: 5, flexWrap: 'wrap', alignItems: 'flex-end' }}>
                  {params.map((pr: any) => (
                    <label key={pr.key} className="muted" style={{ fontSize: 10 }} title={pr.hint}>{pr.label} <span style={{ opacity: .6 }}>({pr.hint.split('(')[0].trim()})</span>
                      <input type="number" min={pr.min} max={pr.max} step={pr.step} value={p.rules[pr.key]} onChange={(e) => setRule(gi, pi, pr.key, e.target.value)} style={{ width: 70, display: 'block' }} /></label>
                  ))}
                  {params.length === 0 && <span className="muted" style={{ fontSize: 10 }}>No numeric threshold (event/cross signal, fires on the event).</span>}
                  <span style={{ width: 1, height: 28, background: 'rgba(255,255,255,.1)' }} />
                  {(['tp', 'sl', 'trail', 'max_position_usd', 'qty'] as const).map((k) => (
                    <label key={k} className="muted" style={{ fontSize: 10 }}>{k === 'max_position_usd' ? 'max $' : k}<input type="number" value={p.risk[k]} onChange={(e) => setRisk(gi, pi, k, e.target.value)} style={{ width: k === 'max_position_usd' ? 64 : 46, display: 'block' }} /></label>
                  ))}
                </div>
              )}
            </div>
          );})}
          {edit && <AddPlay cat={cat} dtes={dtes} bands={bands} onAdd={(key, dte, rules) => addPlay(gi, key, dte, rules)} />}
        </div>
      ))}
    </div>
  );
}

function AddPlay({ cat, dtes, bands, onAdd }: { cat: any[]; dtes: number[]; bands: any; onAdd: (key: string, dte: number, rules: any) => void }) {
  const [open, setOpen] = useState(false);
  const [key, setKey] = useState('');
  const [dte, setDte] = useState(dtes[dtes.length - 1] || 7);
  const [rules, setRules] = useState<any>(null);
  // Default to the first catalog signal once it loads (the catalog may be async).
  useEffect(() => { if (!key && cat[0]?.key) setKey(cat[0].key); }, [cat, key]);
  const sig = cat.find((c: any) => c.key === key) || cat[0];
  // Initialize editable rules from the chosen signal's defaults.
  const ruleObj = rules ?? (sig ? JSON.parse(JSON.stringify(sig.rules)) : {});
  const params = (sig?.params || []);
  const band = bands?.[dte] || bands?.[String(dte)];
  if (!open) return <button style={{ marginTop: 6 }} onClick={() => setOpen(true)}>+ add a play</button>;
  return (
    <div style={{ marginTop: 8, padding: 8, borderRadius: 7, background: 'rgba(0,208,156,.05)', border: '1px solid rgba(0,208,156,.2)' }}>
      <div className="row" style={{ gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <span className="muted" style={{ fontSize: 11 }}>Signal:</span>
        <select value={key} onChange={(e) => { setKey(e.target.value); setRules(null); }} style={{ fontSize: 12 }}>
          <optgroup label="Bullish → calls">{cat.filter((c) => c.dir === 'call').map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}</optgroup>
          <optgroup label="Bearish → puts">{cat.filter((c) => c.dir === 'put').map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}</optgroup>
        </select>
        <span className="muted" style={{ fontSize: 11 }}>DTE:</span>
        <select value={dte} onChange={(e) => setDte(Number(e.target.value))} style={{ fontSize: 12 }}>{dtes.map((d) => <option key={d} value={d}>{d} DTE</option>)}</select>
        {params.map((pr: any) => (
          <label key={pr.key} className="muted" style={{ fontSize: 10 }} title={pr.hint}>{pr.label}
            <input type="number" min={pr.min} max={pr.max} step={pr.step} value={ruleObj[pr.key]} onChange={(e) => setRules({ ...ruleObj, [pr.key]: Number(e.target.value) })} style={{ width: 70, display: 'block' }} /></label>
        ))}
      </div>
      {sig?.explain && <div className="muted" style={{ fontSize: 11, marginTop: 5, lineHeight: 1.4 }}>{sig.explain}</div>}
      {band && <div className="muted" style={{ fontSize: 10, marginTop: 4 }}>{dte}DTE risk band → TP {band.tp}% / SL {band.sl}% / trail {band.trail}% · ≤${band.max_position_usd} (editable after adding)</div>}
      <div className="row" style={{ gap: 6, marginTop: 6 }}>
        <button className="primary" onClick={() => { onAdd(key, dte, ruleObj); setOpen(false); setRules(null); }}>Add play</button>
        <button onClick={() => { setOpen(false); setRules(null); }}>Cancel</button>
      </div>
    </div>
  );
}

// ── Hold policy (no overnight / no weekend) — per-bot, overriding the global default ──
const POLICY_OPTS = [
  { v: 'intraday', label: 'Intraday only: flat before close (no overnight)' },
  { v: 'overnight', label: 'Hold overnight — flat before weekends' },
  { v: 'expiry', label: 'Hold to stops / expiry (matches backtest)' },
];
const modeFrom = (ho: boolean, hw: boolean) => (!ho ? 'intraday' : !hw ? 'overnight' : 'expiry');
const patchFor = (m: string) => m === 'intraday' ? { hold_overnight: false, hold_over_weekend: false } : m === 'overnight' ? { hold_overnight: true, hold_over_weekend: false } : { hold_overnight: true, hold_over_weekend: true };

function HoldPolicy({ bot, global, reload }: { bot: any; global: any; reload: () => void }) {
  const risk = J(bot.risk, {});
  const inherits = typeof risk.hold_overnight !== 'boolean';
  const ho = inherits ? !!global?.holdOvernight : !!risk.hold_overnight;
  const hw = typeof risk.hold_over_weekend === 'boolean' ? risk.hold_over_weekend : !!global?.holdOverWeekend;
  const mode = modeFrom(ho, hw);
  const [busy, setBusy] = useState(false);
  const set = async (m: string) => {
    setBusy(true);
    try {
      await api.put(`/bots/${bot.id}`, { name: bot.name, enabled: bot.enabled, symbols: J(bot.symbols, []), asset_class: 'option', rules: {}, ai_gate: J(bot.ai_gate, { enabled: false }), action: J(bot.action, {}), risk: { ...risk, ...patchFor(m) }, mode: bot.mode });
      reload();
    } finally { setBusy(false); }
  };
  return (
    <div style={{ marginTop: 10 }}>
      <div className="row" style={{ gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <b className="muted" style={{ fontSize: 12 }}>Hold policy:</b>
        <select value={mode} disabled={busy} onChange={(e) => set(e.target.value)} style={{ fontSize: 12 }}>
          {POLICY_OPTS.map((o) => <option key={o.v} value={o.v}>{o.label}</option>)}
        </select>
        {inherits && <span className="muted" style={{ fontSize: 11 }}>(inheriting global default)</span>}
      </div>
      <div className="muted" style={{ fontSize: 11, marginTop: 3, lineHeight: 1.4 }}>
        {mode === 'intraday'
          ? `Positions are closed ~${global?.closeBufferMin ?? 15} min before the session close — nothing held overnight or over weekends. Note: the backtest holds 2–7 days, so intraday-only will exit far earlier than tested — it’s a safety overlay, not the backtested strategy.`
          : mode === 'overnight'
            ? 'Held overnight but flattened before weekends/holidays (avoids weekend gap + theta). Closest safe match to the multi-day strategy.'
            : 'Held to the take-profit / stop-loss / expiry — exactly as backtested (overnight + weekend gap risk accepted).'}
      </div>
    </div>
  );
}

// ── Override-risk editor (the bot's own limits that REPLACE the global ones) ────
function OverrideRisk({ bot, reload }: { bot: any; reload: () => void }) {
  const risk = J(bot.risk, {});
  const [edit, setEdit] = useState<any>(null);
  const [msg, setMsg] = useState('');
  const save = async () => {
    try {
      const newRisk = { ...risk, override: true, max_position_usd: Number(edit.max_position_usd), max_concentration_pct: Number(edit.max_concentration_pct), max_daily_loss_pct: Number(edit.max_daily_loss_pct), max_orders_per_day: Number(edit.max_orders_per_day) };
      await api.put(`/bots/${bot.id}`, { name: bot.name, enabled: bot.enabled, symbols: J(bot.symbols, []), asset_class: 'option', rules: {}, ai_gate: J(bot.ai_gate, { enabled: false }), action: J(bot.action, {}), risk: newRisk, mode: bot.mode });
      setEdit(null); setMsg('saved'); reload();
    } catch (e: any) { setMsg('Error: ' + (e?.message || e)); }
  };
  if (!edit) return (
    <div className="row" style={{ gap: 12, marginTop: 10, flexWrap: 'wrap', alignItems: 'center' }}>
      <span className="pill">override: ≤{money(risk.max_position_usd)}/trade</span>
      <span className="pill">concentration ≤ {risk.max_concentration_pct}%</span>
      <span className="pill">daily-loss ≤ {risk.max_daily_loss_pct}%</span>
      <span className="pill">≤ {risk.max_orders_per_day} orders/day</span>
      <button onClick={() => setEdit({ max_position_usd: risk.max_position_usd ?? 850, max_concentration_pct: risk.max_concentration_pct ?? 35, max_daily_loss_pct: risk.max_daily_loss_pct ?? 25, max_orders_per_day: risk.max_orders_per_day ?? 20 })}>Edit override limits</button>
    </div>
  );
  return (
    <div style={{ marginTop: 10, padding: 12, borderRadius: 8, background: 'var(--panel2)' }}>
      <div className="muted" style={{ fontSize: 12, marginBottom: 6 }}>These REPLACE the global risk limits for this bot (hard blocks like kill-switch still apply):</div>
      <div className="row" style={{ gap: 16, flexWrap: 'wrap' }}>
        {([['max_position_usd', 'Max $/trade'], ['max_concentration_pct', 'Max concentration %'], ['max_daily_loss_pct', 'Max daily loss %'], ['max_orders_per_day', 'Max orders/day']] as const).map(([k, lbl]) => (
          <label key={k} className="muted">{lbl}<input type="number" value={edit[k]} onChange={(e) => setEdit({ ...edit, [k]: e.target.value })} style={{ width: 90, display: 'block' }} /></label>
        ))}
      </div>
      <div className="row" style={{ marginTop: 8 }}><button className="primary" onClick={save}>Save</button><button onClick={() => setEdit(null)}>Cancel</button>{msg && <span className="muted" style={{ fontSize: 12 }}>{msg}</span>}</div>
    </div>
  );
}

function QuickBotCard({ bot, signals, global, reload }: { bot: any; signals: any; global: any; reload: () => void }) {
  const symbols: string[] = J(bot.symbols, []);
  const lr = J(bot.last_result, null);
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<boolean | null>(null);
  const [msg, setMsg] = useState('');
  const enabled = pending ?? !!bot.enabled;

  const toggle = async () => { if (busy) return; setBusy(true); setPending(!enabled); try { await SetBotEnabled(bot.id, !enabled); reload(); } catch { setPending(null); } finally { setBusy(false); } };
  const runNow = async () => { setMsg('evaluating…'); try { await EvalBot(bot.id); setMsg('done — see signal read below'); reload(); } catch (e: any) { setMsg(String(e)); } };

  // Verify each play resolves to a REAL tradable contract on BOTH brokers (esp. Robinhood).
  const [rhCheck, setRhCheck] = useState<any[] | null>(null);
  const [checking, setChecking] = useState(false);
  const verifyRh = async () => {
    setChecking(true); setRhCheck(null);
    const action = J(bot.action, {}); const syms: string[] = J(bot.symbols, []);
    const tuples: { symbol: string; type: string; dte: number }[] = [];
    const add = (symbol: string, plays: any[]) => plays.forEach((p: any) => tuples.push({ symbol, type: p.direction, dte: p.dte }));
    if (action.symbol_plays) syms.forEach((s) => add(s, action.symbol_plays[s] || [])); else add(syms[0], action.plays || []);
    const uniq = tuples.filter((t, i) => tuples.findIndex((u) => u.symbol === t.symbol && u.type === t.type && u.dte === t.dte) === i).slice(0, 12);
    // Resolve all contracts in parallel (was sequential — up to 12 round-trips).
    const out = await Promise.all(uniq.map(async (t) => {
      try { const r: any = await QuickbotResolveCheck(t.symbol, t.type, t.dte); return { ...t, ok: !!r.rh_tradable, readable: r.robinhood?.readable, mid: r.robinhood?.mid, connected: r.rh_connected }; }
      catch (e: any) { return { ...t, ok: false, error: String(e?.message || e) }; }
    }));
    setRhCheck(out); setChecking(false);
  };

  return (
    <Card
      title={<><span className="icon-btn"><Icon name="bolt" size={15} /> {bot.name}</span>{enabled ? <Badge kind="green">ON</Badge> : <Badge kind="gray">off</Badge>}{J(bot.action, {}).symbol_plays ? <Badge kind="blue">per-symbol tuned</Badge> : null}</>}
      right={<div className="row" style={{ gap: 8 }}>
        <div className="mode-seg">{MODES.map((m) => <button key={m} className={bot.mode === m ? `on ${m}` : ''} onClick={async () => { await SetBotMode(bot.id, m); reload(); }}>{m === 'full_auto' ? 'full' : m.slice(0, 4)}</button>)}</div>
        <button className={enabled ? 'primary' : ''} disabled={busy} onClick={toggle}>{busy ? '…' : enabled ? 'ON' : 'off'}</button>
      </div>}
    >
      <div className="muted" style={{ marginBottom: 4 }}>
        Trades <b>{symbols.map((s, i) => <span key={s}>{i ? ', ' : ''}<Sym>{s}</Sym></span>)}</b> — short-dated calls & puts by signal, DTE-scaled risk. Strategy tuned by a 1-year backtest (below). Custom risk <b>overrides all global limits</b>.
      </div>

      <div className="row" style={{ marginBottom: 4, gap: 8, alignItems: 'flex-start' }}>
        <span className="muted" style={{ fontSize: 11, fontWeight: 700, letterSpacing: '.4px' }}>RISK</span>
        <RiskCell bot={bot} reload={reload} />
      </div>
      <div className="muted" style={{ fontSize: 11, marginBottom: 6 }}>
        Each play below exits on its own DTE-scaled stop and trail; the amount per trade above decides how many contracts it buys, inside that play's dollar cap.
      </div>

      <PlaysManager bot={bot} signals={signals} reload={reload} />
      <HoldPolicy bot={bot} global={global} reload={reload} />
      <OverrideRisk bot={bot} reload={reload} />

      <div className="row" style={{ marginTop: 8, gap: 8 }}>
        <button onClick={runNow}>Run now (signal read)</button>
        <button onClick={verifyRh} disabled={checking}>{checking ? 'checking…' : 'Verify on Robinhood'}</button>
        {msg && <span className="muted" style={{ fontSize: 11 }}>{msg}</span>}
      </div>
      {rhCheck && (
        <div style={{ marginTop: 6 }}>
          <div className="muted" style={{ fontSize: 11 }}>Robinhood tradability ({rhCheck.filter((r) => r.ok).length}/{rhCheck.length} resolve to a real RH contract):</div>
          {rhCheck.map((r, i) => (
            <div key={i} style={{ fontSize: 12 }}>
              <span className={r.ok ? 'green' : 'red'}>{r.ok ? <Icon name="check" size={14} /> : <Icon name="x" size={14} />}</span> <Sym>{r.symbol}</Sym> {r.type} {r.dte}DTE
              <span className="muted"> — {r.ok ? `${r.readable} @ ${r.mid != null ? '$' + r.mid : 'no quote'}` : (r.connected === false ? 'Robinhood not connected' : r.error || 'not tradable')}</span>
            </div>
          ))}
        </div>
      )}

      {Array.isArray(lr) && lr.length > 0 && (
        <div style={{ marginTop: 8 }}>
          <div className="muted" style={{ fontSize: 11 }}>Latest signal read:</div>
          {lr.slice(0, 6).map((r: any, i: number) => (
            <div key={i} style={{ fontSize: 12, marginTop: 2 }}>
              <Sym>{r.symbol}</Sym> {r.fired ? <Badge kind="green">fired</Badge> : <Badge kind="gray">no trade</Badge>} <span className="muted">{String(r.why || r.error || '').slice(0, 150)}</span>
            </div>
          ))}
        </div>
      )}

      <BacktestPanel bot={bot} />
    </Card>
  );
}

function EnvBanner() {
  const health = useAsync<any>(Health, [], 15000);
  const h = health.data; if (!h) return null;
  const rh = h.env === 'robinhood_live';
  const rhConnected = h.rh?.status === 'connected';
  const ok = rh ? rhConnected : !!h.broker?.alpacaConfigured;
  return (
    <div style={{ padding: '8px 12px', borderRadius: 8, marginBottom: 4, background: ok ? 'rgba(0,208,156,.07)' : 'rgba(245,176,65,.1)', border: `1px solid ${ok ? 'rgba(0,208,156,.25)' : 'rgba(245,176,65,.3)'}`, fontSize: 13 }}>
      Trading environment: <b>{rh ? 'Robinhood (LIVE agentic account)' : 'Alpaca (paper)'}</b>.{' '}
      {rh
        ? (rhConnected
            ? <>QuickBots place <b>long calls/puts</b> on your agentic cash account (long-only, defined risk). Contracts resolve against Robinhood’s own chain. Note: until the account is funded, live orders are rejected for buying power — test in Paper first.</>
            : <span className="amber">Robinhood is not connected — connect it in Settings before enabling live.</span>)
        : <>QuickBots place options on the Alpaca paper account. Switch the environment (top bar) to Robinhood to trade them live.</>}
      {' '}Strategy backtests always use real market data and work the same in both.
    </div>
  );
}

function TriggerReference({ signals }: { signals: any }) {
  const cat: any[] = signals?.signals || [];
  if (!cat.length) return null;
  const Section = ({ dir, title }: { dir: string; title: React.ReactNode }) => (
    <div style={{ marginTop: 8 }}>
      <div className="icon-btn" style={{ fontWeight: 600, marginBottom: 4 }}>{title}</div>
      {cat.filter((c) => c.dir === dir).map((c) => (
        <div key={c.key} style={{ padding: '6px 0', borderTop: '1px solid rgba(255,255,255,.05)' }}>
          <div><b>{c.label}</b> {c.params?.length ? c.params.map((p: any) => <span key={p.key} className="pill" style={{ fontSize: 10 }}>{p.label}: {p.value} ({p.min}–{p.max})</span>) : <span className="muted" style={{ fontSize: 11 }}>event/cross — no threshold</span>}</div>
          <div className="muted" style={{ fontSize: 12, lineHeight: 1.45, marginTop: 2 }}>{c.explain}</div>
        </div>
      ))}
    </div>
  );
  return (
    <Card title={<><span className="icon-btn"><Icon name="orders" size={15} /> Trigger rules & best practices</span><Info topic="quickbot_bt" /></>}>
      <details>
        <summary style={{ cursor: 'pointer', fontSize: 13 }}>How the triggers work, what each does, and how to tweak them (click to expand)</summary>
        <div style={{ marginTop: 8 }}>
          <div className="muted" style={{ fontSize: 12, lineHeight: 1.5 }}>
            Each <b>play</b> = a trigger signal + a direction (call/put) + a DTE + DTE-scaled risk. A bot evaluates its plays every cycle during
            market hours; when a play's signal fires it buys that option (deduped to once/day per contract). <b>Best practices baked in:</b>{' '}
            (1) <b>trade WITH the trend</b> — calls need an uptrend filter, puts a downtrend filter (long premium needs follow-through, not a fade);{' '}
            (2) <b>cross/event signals fire once</b> when momentum turns, not every day it persists;{' '}
            (3) <b>tighter stops + smaller size on short DTE</b> (fast theta), more room + size on 7-day;{' '}
            (4) thresholds are tunable — raise them for fewer, higher-conviction trades, lower for more (noisier) ones. The defaults are the
            empirically robust presets (positive in both halves of a 1-year backtest, after costs).
          </div>
          <Section dir="call" title={<><Icon name="chart" size={15} /> Bullish signals → buy CALLS</>} />
          <Section dir="put" title={<><Icon name="chart" size={15} /> Bearish signals → buy PUTS</>} />
        </div>
      </details>
    </Card>
  );
}

function GlobalHoldPolicy() {
  const { data, reload } = useAsync<any>(ExitPolicy, []);
  const p = data?.policy;
  const [busy, setBusy] = useState(false);
  if (!p) return null;
  const mode = modeFrom(!!p.holdOvernight, !!p.holdOverWeekend);
  const set = async (patch: any) => { setBusy(true); try { await SetExitPolicy(patch); reload(); } finally { setBusy(false); } };
  return (
    <div className="row" style={{ gap: 8, marginTop: 8, flexWrap: 'wrap', alignItems: 'center' }}>
      <b className="muted" style={{ fontSize: 12 }}>Global default hold policy:</b>
      <select value={mode} disabled={busy} onChange={(e) => set(patchFor(e.target.value))} style={{ fontSize: 12 }}>
        {POLICY_OPTS.map((o) => <option key={o.v} value={o.v}>{o.label}</option>)}
      </select>
      <label className="muted" style={{ fontSize: 11 }}>close buffer
        <input type="number" min={2} max={60} value={p.closeBufferMin} disabled={busy} onChange={(e) => set({ closeBufferMin: Number(e.target.value) })} style={{ width: 52, marginLeft: 4 }} /> min</label>
      <span className="muted" style={{ fontSize: 11 }}>applies to every bot that hasn’t set its own policy below.</span>
    </div>
  );
}

export default function QuickBotsView() {
  const { data, reload } = useAsync<any[]>(Quickbots, [], 0);
  const health = useAsync<any>(Health, [], 15000);
  const signals = useAsync<any>(QuickbotSignals, []);
  // QuickBots belong to the active account: refetch the fleet when the account changes.
  const env = health.data?.env;
  useEffect(() => { if (env) reload(); }, [env]);
  const exitPolicy = useAsync<any>(ExitPolicy, [], 0);
  const [seeding, setSeeding] = useState(false);
  const [msg, setMsg] = useState('');
  const bots = data || [];

  const reseed = async () => {
    if (!confirm('Re-run the 1-year backtests and RE-TUNE both QuickBots (basket tuned per-symbol)? Overwrites current plays, not enabled state.')) return;
    setSeeding(true); setMsg('');
    try { const r: any = await SeedQuickbots(true); setMsg(`Re-tuned: ${(r.seeded || []).map((s: any) => `${s.name?.split('—')[0]?.trim() || s.name}${s.per_symbol ? ` (per-symbol: ${Object.entries(s.per_symbol).map(([k, v]) => `${k} ${v}`).join(', ')})` : ` (${s.plays} plays)`}`).join(' · ')}`); reload(); }
    catch (e: any) { setMsg('Error: ' + (e?.message || e)); }
    finally { setSeeding(false); }
  };

  return (
    <div className="grid" style={{ gap: 14 }}>
      <EnvBanner />
      <Card title={<><span className="icon-btn"><Icon name="bolt" size={15} /> QuickBots</span><Info topic="quickbot" /> <FleetBadge env={env} /></>} right={<button onClick={reseed} disabled={seeding}>{seeding ? 're-tuning…' : 'Re-tune from latest data'}</button>}>
        <div className="muted" style={{ lineHeight: 1.5 }}>
          Your go-to one-tap options bots. Each trades short-dated (2–7 DTE) <b>calls and puts</b>, picking direction and expiry
          from momentum/breakdown signals with risk that scales by DTE. Default plays are chosen <b>empirically</b> from a 1-year
          Black-Scholes-priced, spread-costed, out-of-sample-validated backtest. The basket bot is <b>auto-tuned per symbol</b>.
          Add or remove plays per bot below. They ship in <b>Cautious</b> mode (orders staged for approval).
          {msg && <div style={{ marginTop: 6 }} className="green">{msg}</div>}
          <GlobalHoldPolicy />
        </div>
      </Card>
      <TriggerReference signals={signals.data} />
      {bots.length === 0 && <Card title="No QuickBots yet"><div className="muted">Click “Re-tune from latest data” to build them from a fresh backtest.</div></Card>}
      {bots.map((b) => <QuickBotCard key={b.id} bot={b} signals={signals.data} global={exitPolicy.data?.policy} reload={reload} />)}
    </div>
  );
}
