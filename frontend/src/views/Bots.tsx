import { useState, useEffect, useRef } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Bots, SetBotEnabled, SetBotMode, EvalBot, BacktestBot, Health, api } from '../api/client';
import { Card, Badge, FleetBadge, useAsync, Sym } from '../components/ui';
import { Icon } from '../components/icons';
import { optionLabelFromAction } from '../lib/options';
import BotWizard, { type BotPreset } from '../components/BotWizard';
import { PromotionModal } from '../components/quanttools';
import { RiskCell } from '../components/risksizing';

const MODES = ['observe', 'cautious', 'auto', 'full_auto'];

function J(v: any, d: any) { if (v == null) return d; if (typeof v === 'object') return v; try { return JSON.parse(v); } catch { return d; } }
function clampInt(v: any, lo: number, hi: number, d: number) { const n = Math.floor(Number(v)); return Number.isFinite(n) && n > 0 ? Math.min(hi, Math.max(lo, n)) : d; }

const RULE_TEXT: Record<string, (v: any) => string> = {
  rsi_below: (v) => `RSI(14) below ${v}`,
  rsi_above: (v) => `RSI(14) above ${v}`,
  ema_cross: () => 'EMA9 above EMA21 (momentum up)',
  price_above_sma20: () => 'price above its 20-day average',
  macd_positive: () => 'MACD histogram positive',
  golden_cross: () => 'SMA50 above SMA200 (golden cross)',
  death_cross: () => 'SMA50 below SMA200 (death cross)',
  bollinger_lower: () => 'price below lower Bollinger band',
  bollinger_upper: () => 'price above upper Bollinger band',
  breakout_high: () => 'new 20-day high (breakout)',
  breakdown_low: () => 'new 20-day low (breakdown)',
  change_above: (v) => `up more than ${v}% on the day`,
  change_below: (v) => `down more than ${Math.abs(v)}% on the day`,
};

function explain(rules: any, action: any, aiGate: any): string {
  // QuickBots keep their triggers in action.plays (calls AND puts, DTE-scaled), NOT in the
  // generic `rules` field — so describe them from the plays and point to the QuickBots page.
  if (action?._quickbot) {
    const plays = action.plays || [];
    const c = plays.filter((p: any) => p.direction === 'call').length;
    const p = plays.filter((p: any) => p.direction === 'put').length;
    const tuned = action.symbol_plays ? ' (auto-tuned per symbol)' : '';
    return `QuickBot${tuned}: ${c} call + ${p} put short-DTE play(s), each with its own signal, expiry and DTE-scaled risk. Edit its triggers, presets and backtest on the QuickBots page — not here.`;
  }
  const parts = Object.entries(rules || {})
    .filter(([k]) => k !== 'require_all' && k !== 'min_matches')
    .map(([k, v]) => (RULE_TEXT[k] ? RULE_TEXT[k](v) : `${k}=${v}`));
  if (!parts.length) return 'No rules configured — this bot will not fire.';
  const joiner = rules.require_all ? ' AND ' : (rules.min_matches > 1 ? ` (any ${rules.min_matches}) ` : ' or ');
  let s = `Fires when ${parts.join(joiner)}.`;
  if (action?.option_type) s += ` Then buys a ${action.strike_target || 'ATM'} ${action.expiration || 'weekly'} ${action.option_type} (long, defined risk).`;
  else s += ` Then ${action?.side || 'buys'} ${action?.qty || 1} share(s).`;
  if (aiGate?.enabled) s += ` Claude must also confirm (conviction ≥ ${aiGate.min_conviction ?? 0.5}).`;
  return s;
}

/** Compute health issues + a fix CTA for a bot, given backend health. */
function issues(bot: any, health: any): { msg: string; cta?: string; href?: string; kind: string }[] {
  const out: any[] = [];
  const lr = J(bot.last_result, null);
  const errs = Array.isArray(lr) ? lr.filter((r: any) => r?.error || r?.skipped) : [];
  for (const e of errs) out.push({ kind: 'red', msg: `${e.symbol || ''}: ${e.error || e.skipped}` });

  if (bot.asset_class === 'option' && health && !health.broker?.alpacaConfigured) {
    out.push({ kind: 'amber', msg: 'Options need market data — Alpaca not configured.', cta: 'Open Settings', href: '#/settings' });
  }
  if (bot.enabled && health?.env === 'robinhood_live' && health?.rh?.status !== 'connected') {
    out.push({ kind: 'amber', msg: 'Live env selected but Robinhood is not connected.', cta: 'Connect Robinhood', href: '#/settings' });
  }
  // QuickBots fire from action.plays, not `rules` — the generic "no rules" check doesn't
  // apply (it would falsely flag a working bot). They're managed on the QuickBots page.
  if (J(bot.action, {})._observe_only || J(bot.rules, {})._observe_only || /Mean-Revert Watch|Quiet Range Scout|Vol-Regime MR/i.test(bot.name || '')) {
    out.push({ kind: 'blue', msg: 'Watch stub — even while ON it cannot place, stage, or draft an order.' });
  }
  if (J(bot.action, {})._quickbot) return out;
  const rules = J(bot.rules, {});
  if (!Object.keys(rules).filter((k) => k !== 'require_all' && k !== 'min_matches').length) {
    out.push({ kind: 'red', msg: 'No trigger rules — bot cannot fire.', cta: 'Edit rules' });
  }
  return out;
}

/** Per-symbol "why it did / didn't fire" breakdown from a bot's last evaluation. */
function EvalReason({ res }: { res: any }) {
  const checks: any[] = Array.isArray(res.checks) ? res.checks : [];
  const fired = !!res.fired;
  const acted = fired && (res.status || res.action);
  const statusBadge = res.error ? <Badge kind="red">error</Badge>
    : res.skipped ? <Badge kind="gray">skipped</Badge>
    : acted ? <Badge kind="green">fired → {res.action || res.status}</Badge>
    : fired ? <Badge kind="amber">fired (gated)</Badge>
    : <Badge kind="gray">no trade</Badge>;
  return (
    <div style={{ marginTop: 6, padding: '6px 10px', borderRadius: 7, background: 'rgba(255,255,255,.03)' }}>
      <div className="row" style={{ justifyContent: 'space-between', gap: 8 }}>
        <span><Sym bold>{res.symbol}</Sym> {statusBadge}</span>
      </div>
      <div style={{ fontSize: 12, marginTop: 3 }}>{res.why || res.error || res.skipped || res.reason || (fired ? 'fired' : 'no signal')}</div>
      {checks.length > 0 && (
        <div className="row" style={{ gap: 12, flexWrap: 'wrap', marginTop: 5 }}>
          {checks.map((c, i) => (
            <span key={i} style={{ fontSize: 11 }} title={c.kind === 'filter' ? 'trend filter (must hold)' : 'entry trigger'}>
              <span className={c.ok ? 'green' : 'red'}>{c.ok ? <Icon name="check" size={14} /> : <Icon name="x" size={14} />}</span>{' '}
              <span className="muted">{c.detail}{c.kind === 'filter' ? ' [filter]' : ''}</span>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

function BotRow({ bot, health, reload, defaultOpen = false, focus = false, autoEdit = false }: { bot: any; health: any; reload: () => void; defaultOpen?: boolean; focus?: boolean; autoEdit?: boolean }) {
  const [open, setOpen] = useState(defaultOpen || focus);
  const [edit, setEdit] = useState<any>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const [msg, setMsg] = useState('');
  const [bt, setBt] = useState<any>(null);
  const [promote, setPromote] = useState(false);
  // Optimistic enabled state: reflects the click instantly so the button never looks
  // unresponsive (which previously tempted a second click that flipped it back off).
  const [pendingEnabled, setPendingEnabled] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const shownEnabled = pendingEnabled ?? !!bot.enabled;
  // Once the refetched server state matches our optimistic value, drop the override.
  useEffect(() => { if (pendingEnabled != null && !!bot.enabled === pendingEnabled) setPendingEnabled(null); }, [bot.enabled, pendingEnabled]);

  const setEnabled = async (want: boolean) => {
    if (busy) return;
    setBusy(true); setPendingEnabled(want);
    try {
      await SetBotEnabled(bot.id, want); // idempotent — safe regardless of prior state
      reload();
    } catch (e: any) {
      setPendingEnabled(null); setMsg('Error: ' + (e?.message || e));
    } finally { setBusy(false); }
  };

  const symbols = J(bot.symbols, []);
  const action = J(bot.action, {});
  const rules = J(bot.rules, {});
  const aiGate = J(bot.ai_gate, { enabled: false });
  const lr = J(bot.last_result, null);
  const probs = issues(bot, health);

  const startEdit = () => setEdit({
    name: bot.name,
    symbols: symbols.join(', '),
    asset_class: bot.asset_class,
    mode: bot.mode,
    qty: action.qty ?? 1,
    side: action.side ?? 'buy',
    option_type: action.option_type ?? '',
    strike_target: action.strike_target ?? 'atm',
    expiration: action.expiration ?? 'weekly',
    ai_enabled: !!aiGate.enabled,
    min_conviction: aiGate.min_conviction ?? 0.6,
    max_entries_per_day: J(bot.risk, {}).max_entries_per_day ?? 4,
    reentry_cooldown_min: J(bot.risk, {}).reentry_cooldown_min ?? 45,
    // Show the EFFECTIVE exits (bot's own, else the global trade defaults) so this form and
    // the Risk control above it never disagree. Saving here pins them to the bot.
    stop_loss_pct: J(bot.risk, {}).stop_loss_pct ?? bot.effective_risk?.stop_loss_pct ?? (bot.asset_class === 'option' ? 35 : 8),
    trailing_stop_pct: J(bot.risk, {}).trailing_stop_pct ?? bot.effective_risk?.trailing_stop_pct ?? (bot.asset_class === 'option' ? 40 : 12),
    take_profit_pct: J(bot.risk, {}).take_profit_pct ?? bot.effective_risk?.take_profit_pct ?? 0,
    rules: JSON.stringify(rules, null, 2),
  });

  // Deep-link target (e.g. "Edit" from the dashboard): expand, scroll into view, and
  // optionally open the edit form. Runs once when this row is the focused bot.
  useEffect(() => {
    if (!focus) return;
    setOpen(true);
    if (autoEdit) startEdit();
    cardRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focus]);

  const save = async () => {
    try {
      const newRules = JSON.parse(edit.rules);
      const newAction: any = { ...action, side: edit.side, qty: Number(edit.qty), order_type: action.order_type || 'market' };
      if (edit.asset_class === 'option') { newAction.option_type = edit.option_type || 'call'; newAction.strike_target = edit.strike_target; newAction.expiration = edit.expiration; }
      await api.put(`/bots/${bot.id}`, {
        name: edit.name,
        enabled: bot.enabled,
        symbols: edit.symbols.split(',').map((s: string) => s.trim().toUpperCase()).filter(Boolean),
        asset_class: edit.asset_class,
        rules: newRules,
        ai_gate: { enabled: edit.ai_enabled, min_conviction: Number(edit.min_conviction) },
        action: newAction,
        risk: { ...J(bot.risk, {}), max_entries_per_day: clampInt(edit.max_entries_per_day, 1, 10, 4), reentry_cooldown_min: clampInt(edit.reentry_cooldown_min, 1, 390, 45), stop_loss_pct: Math.max(0, Number(edit.stop_loss_pct) || 0), trailing_stop_pct: Math.max(0, Number(edit.trailing_stop_pct) || 0), take_profit_pct: Math.max(0, Number(edit.take_profit_pct) || 0) },
        mode: edit.mode,
      });
      setEdit(null); setMsg('saved'); reload();
    } catch (e: any) { setMsg('Error: ' + (e?.message || e)); }
  };

  const runEval = async () => { setMsg('evaluating…'); const r = await EvalBot(bot.id); setMsg(JSON.stringify(r)); reload(); };
  const runBt = async () => {
    setBt('running…');
    try { const r: any = await BacktestBot(bot.id, 90); setBt(r.aggregate?.metrics || { error: 'no result' }); }
    catch (e: any) { setBt({ error: String(e) }); }
  };

  return (
    <div ref={cardRef} className="card" style={{ background: 'var(--panel2)', marginBottom: 8, borderColor: focus ? 'var(--accent)' : probs.some(p => p.kind==='red') ? 'rgba(255,92,92,.4)' : 'var(--border)' }}>
      <div className="row" style={{ justifyContent: 'space-between', cursor: 'pointer' }} onClick={() => setOpen(!open)}>
        <div className="row" style={{ gap: 8 }}>
          <span>{open ? '▾' : '▸'}</span>
          <b>{bot.name}</b>
          {(action._observe_only || rules._observe_only || /watch|scout|vol-regime mr/i.test(bot.name || '')) && (
            <Badge kind="blue">watch only</Badge>
          )}
          {action.option_type && <Badge kind={action.option_type === 'call' ? 'green' : 'red'}>{action.option_type}</Badge>}
          {action._category && <span className="pill">{action._category}</span>}
          {probs.length > 0 && <Badge kind={probs.some(p=>p.kind==='red')?'red':'amber'}>{probs.length} issue{probs.length>1?'s':''}</Badge>}
        </div>
        <div className="row" onClick={(e) => e.stopPropagation()}>
          <span className="muted" style={{ fontSize: 11 }}>{symbols.join(', ')}</span>
          <div className="mode-seg">
            {MODES.map((m) => (
              <button key={m} className={bot.mode === m ? `on ${m}` : ''} onClick={async () => { await SetBotMode(bot.id, m); reload(); }}>{m === 'full_auto' ? 'full' : m.slice(0, 4)}</button>
            ))}
          </div>
          <button className={shownEnabled ? 'primary' : ''} disabled={busy} onClick={() => setEnabled(!shownEnabled)}>{busy ? '…' : shownEnabled ? 'ON' : 'off'}</button>
        </div>
      </div>

      {/* Risk: what this bot puts into one trade and where it exits. Tap to change. */}
      <div className="row" style={{ marginTop: 8, gap: 8, alignItems: 'flex-start' }} onClick={(e) => e.stopPropagation()}>
        <span className="muted" style={{ fontSize: 11, fontWeight: 700, letterSpacing: '.4px' }}>RISK</span>
        <RiskCell bot={bot} reload={reload} />
      </div>

      {open && (
        <div style={{ marginTop: 12 }}>
          <div style={{ marginBottom: 10 }}><b className="muted">How it works:</b> {explain(rules, action, aiGate)}</div>

          {action._quickbot && (
            <div className="row" style={{ justifyContent: 'space-between', padding: '8px 10px', borderRadius: 7, marginBottom: 10, background: 'rgba(0,208,156,.08)', border: '1px solid rgba(0,208,156,.25)' }}>
              <span className="icon-btn"><Icon name="bolt" size={15} /> This is a QuickBot — its calls/puts, trigger rules, presets and backtest are managed on the dedicated page (editing rules here won't apply).</span>
              <a href="#/quickbots">Open QuickBots →</a>
            </div>
          )}

          {probs.length > 0 && (
            <div style={{ marginBottom: 10 }}>
              {probs.map((p, i) => (
                <div key={i} className="row" style={{ justifyContent: 'space-between', padding: '6px 10px', borderRadius: 7, marginBottom: 4,
                  background: p.kind === 'red' ? 'rgba(255,92,92,.1)' : 'rgba(245,176,65,.1)', border: `1px solid ${p.kind==='red'?'rgba(255,92,92,.3)':'rgba(245,176,65,.3)'}` }}>
                  <span className={`icon-btn ${p.kind === 'red' ? 'red' : 'amber'}`}><Icon name="warning" size={14} /> {p.msg}</span>
                  {p.cta && (p.href ? <a href={p.href}>{p.cta} →</a> : <button onClick={startEdit}>{p.cta}</button>)}
                </div>
              ))}
            </div>
          )}

          {!edit ? (
            <div className="row">
              <button onClick={startEdit}>Edit settings</button>
              <button onClick={runEval}>Run now</button>
              <button onClick={runBt}>Backtest 90d</button>
              <button className="icon-btn" onClick={() => setPromote(true)} title="Run the paper→live graduation checklist">{action._graduated ? <><Icon name="check" size={14} /> Graduated</> : <><Icon name="shield" size={14} /> Promote to live</>}</button>
            </div>
          ) : (
            <div className="grid" style={{ gap: 8, gridTemplateColumns: '1fr 1fr' }}>
              <label className="muted">Name<input value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} style={{ width: '100%' }} /></label>
              <label className="muted">Symbols (comma)<input value={edit.symbols} onChange={(e) => setEdit({ ...edit, symbols: e.target.value })} style={{ width: '100%' }} /></label>
              <label className="muted">Asset class
                <select value={edit.asset_class} onChange={(e) => setEdit({ ...edit, asset_class: e.target.value })} style={{ width: '100%' }}>
                  <option value="equity">equity</option><option value="etf">etf</option><option value="option">option</option>
                </select>
              </label>
              <label className="muted">Mode
                <select value={edit.mode} onChange={(e) => setEdit({ ...edit, mode: e.target.value })} style={{ width: '100%' }}>{MODES.map(m => <option key={m}>{m}</option>)}</select>
              </label>
              <label className="muted">Side
                <select value={edit.side} onChange={(e) => setEdit({ ...edit, side: e.target.value })} style={{ width: '100%' }}><option>buy</option><option>sell</option></select>
              </label>
              <label className="muted">Qty<input value={edit.qty} onChange={(e) => setEdit({ ...edit, qty: e.target.value })} style={{ width: '100%' }} /></label>
              {edit.asset_class === 'option' && (
                <>
                  <label className="muted">Option
                    <select value={edit.option_type} onChange={(e) => setEdit({ ...edit, option_type: e.target.value })} style={{ width: '100%' }}><option value="call">call</option><option value="put">put</option></select>
                  </label>
                  <label className="muted">Strike
                    <select value={edit.strike_target} onChange={(e) => setEdit({ ...edit, strike_target: e.target.value })} style={{ width: '100%' }}><option>atm</option><option>otm</option><option>itm</option></select>
                  </label>
                  <label className="muted">Expiration
                    <select value={edit.expiration} onChange={(e) => setEdit({ ...edit, expiration: e.target.value })} style={{ width: '100%' }}><option>weekly</option><option>monthly</option></select>
                  </label>
                </>
              )}
              <label className="muted">Claude gate
                <div className="row"><input type="checkbox" checked={edit.ai_enabled} onChange={(e) => setEdit({ ...edit, ai_enabled: e.target.checked })} />
                  min conv <input value={edit.min_conviction} onChange={(e) => setEdit({ ...edit, min_conviction: e.target.value })} style={{ width: 60 }} /></div>
              </label>
              <label className="muted">Max entries / day
                <input type="number" min={1} max={10} value={edit.max_entries_per_day} onChange={(e) => setEdit({ ...edit, max_entries_per_day: e.target.value })} style={{ width: '100%' }} />
                <span style={{ fontSize: 10 }}>how many times this bot may re-enter the same symbol in a day (1–10)</span>
              </label>
              <label className="muted">Re-entry cooldown (min)
                <input type="number" min={1} max={390} value={edit.reentry_cooldown_min} onChange={(e) => setEdit({ ...edit, reentry_cooldown_min: e.target.value })} style={{ width: '100%' }} />
                <span style={{ fontSize: 10 }}>minimum minutes between entries so a persistent signal spreads out (1–390)</span>
              </label>
              <div style={{ gridColumn: '1 / -1', fontSize: 11, fontWeight: 700, color: 'var(--green)', marginTop: 4 }}>Exits — small loss / big win (positive skew)</div>
              <label className="muted">Stop-loss %
                <input type="number" min={0} value={edit.stop_loss_pct} onChange={(e) => setEdit({ ...edit, stop_loss_pct: e.target.value })} style={{ width: '100%' }} />
                <span style={{ fontSize: 10 }}>cut a loser here — keep it small</span>
              </label>
              <label className="muted">Trailing-stop %
                <input type="number" min={0} value={edit.trailing_stop_pct} onChange={(e) => setEdit({ ...edit, trailing_stop_pct: e.target.value })} style={{ width: '100%' }} />
                <span style={{ fontSize: 10 }}>lets a winner run, exits on a pullback from its peak</span>
              </label>
              <label className="muted">Take-profit % (0 = no cap)
                <input type="number" min={0} value={edit.take_profit_pct} onChange={(e) => setEdit({ ...edit, take_profit_pct: e.target.value })} style={{ width: '100%' }} />
                <span style={{ fontSize: 10 }}>0 = let winners run (recommended). A value caps your upside.</span>
              </label>
              <label className="muted" style={{ gridColumn: '1 / -1' }}>Rules (JSON)
                <textarea value={edit.rules} onChange={(e) => setEdit({ ...edit, rules: e.target.value })} rows={5} style={{ width: '100%', fontFamily: 'monospace' }} />
              </label>
              <div className="row" style={{ gridColumn: '1 / -1' }}>
                <button className="primary" onClick={save}>Save</button>
                <button onClick={() => setEdit(null)}>Cancel</button>
              </div>
            </div>
          )}

          {bt && <div className="muted" style={{ marginTop: 8, fontSize: 12 }}>Backtest: {typeof bt === 'string' ? bt : bt.error ? <span className="red">{bt.error}</span> : `${bt.total_return_pct}% total · ${bt.num_trades} trades · ${bt.win_rate}% win · best ${bt.best_multiple}x · ≥2x ${bt.trades_2x} — open the Backtest tab for charts & date range`}</div>}
          {msg && <div className="muted" style={{ marginTop: 6, fontSize: 11 }}>{msg}</div>}

          {Array.isArray(lr) && lr.length > 0 && (
            <div style={{ marginTop: 12 }}>
              <div className="row" style={{ justifyContent: 'space-between' }}>
                <b className="muted">Latest evaluation — why it did / didn't fire</b>
                <span className="muted" style={{ fontSize: 11 }}>{bot.last_evaluated_at ? new Date(bot.last_evaluated_at).toLocaleString('en-US', { timeZone: 'America/Los_Angeles' }) : ''}</span>
              </div>
              {lr.map((res: any, i: number) => <EvalReason key={(res.symbol || i) + ':' + i} res={res} />)}
            </div>
          )}
          {(!lr || (Array.isArray(lr) && lr.length === 0)) && (
            <div className="muted" style={{ marginTop: 10, fontSize: 12 }}>Not evaluated yet. Click <b>Run now</b> to evaluate against the latest data and see exactly which conditions hold.</div>
          )}
        </div>
      )}
      {promote && <PromotionModal botId={bot.id} onClose={() => setPromote(false)} onPromoted={reload} />}
    </div>
  );
}

export default function BotsView() {
  const { data, reload } = useAsync<any[]>(Bots, [], 0);
  const health = useAsync<any>(Health, [], 10000);
  // Bots belong to the active account, so the list is refetched when the account changes.
  const env = health.data?.env;
  useEffect(() => { if (env) reload(); }, [env]);
  const [wizard, setWizard] = useState<BotPreset | null>(null);
  const [params, setParams] = useSearchParams();
  const bots = data || [];
  const broken = bots.filter((b) => issues(b, health.data).some((p) => p.kind === 'red')).length;

  // Deep-link controls (set by the dashboard "manage →" link and per-bot "Edit"):
  //   ?open=enabled  → expand every enabled bot   ?open=all → expand all
  //   ?bot=<id>      → scroll to + expand that bot   &edit=1 → open its edit form
  const openParam = params.get('open');
  const botParam = params.get('bot');
  const editParam = params.get('edit') === '1';
  const enabledCount = bots.filter((b) => b.enabled).length;

  // Filter + sort the bot list (separate from the deep-link expand controls).
  const [q, setQ] = useState('');
  const [statusFilter, setStatusFilter] = useState<'all' | 'on' | 'off'>('all');
  const [sortKey, setSortKey] = useState<'id' | 'name' | 'last' | 'mode' | 'asset'>('id');
  const shown = bots
    .filter((b) => statusFilter === 'all' || (statusFilter === 'on' ? b.enabled : !b.enabled))
    .filter((b) => { if (!q.trim()) return true; const hay = `${b.name} ${(J(b.symbols, []) as string[]).join(' ')} ${b.asset_class} ${b.mode}`.toLowerCase(); return hay.includes(q.toLowerCase()); })
    .slice()
    .sort((a, b) => {
      if (sortKey === 'name') return String(a.name).localeCompare(String(b.name));
      if (sortKey === 'last') return String(b.last_evaluated_at || '').localeCompare(String(a.last_evaluated_at || ''));
      if (sortKey === 'mode') return String(a.mode).localeCompare(String(b.mode));
      if (sortKey === 'asset') return String(a.asset_class).localeCompare(String(b.asset_class));
      return a.id - b.id;
    });

  return (
    <>
    {wizard !== null && <BotWizard preset={wizard} onClose={() => setWizard(null)} onCreated={reload} />}
    <Card title={<span className="row" style={{ gap: 8 }}>Bots ({bots.length}) <FleetBadge env={env} /></span>} right={<span className="row" style={{ gap: 8 }}><button className="primary" onClick={() => setWizard({})}>+ New bot (wizard)</button><a href="#/quickbots" className="icon-btn"><Icon name="bolt" size={14} /> QuickBots</a><a href="#/strategies">Strategy Library</a></span>}>
      <div className="muted" style={{ marginBottom: 10 }}>
        Click a bot to expand: see how it works, edit every setting, run/backtest it, and enable it.
        {broken > 0 && <span className="red"> {broken} bot(s) have issues that need fixing.</span>}
        {health.data && !health.data.broker?.alpacaConfigured && <span className="amber"> Alpaca market data is not configured — options bots can't get prices.</span>}
      </div>
      {/* Filter / sort controls */}
      <div className="row" style={{ gap: 8, marginBottom: 10, flexWrap: 'wrap', alignItems: 'center' }}>
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="filter name / symbol…" style={{ width: 200 }} />
        <div className="mode-seg">
          {(['all', 'on', 'off'] as const).map((s) => <button key={s} className={statusFilter === s ? 'on' : ''} onClick={() => setStatusFilter(s)}>{s === 'all' ? 'All' : s === 'on' ? 'Enabled' : 'Disabled'}</button>)}
        </div>
        <label className="muted" style={{ fontSize: 12 }}>sort
          <select value={sortKey} onChange={(e) => setSortKey(e.target.value as any)} style={{ marginLeft: 4 }}>
            <option value="id">default</option><option value="name">name</option><option value="last">last eval</option><option value="mode">mode</option><option value="asset">asset class</option>
          </select>
        </label>
        <span className="muted" style={{ fontSize: 11 }}>{shown.length}{shown.length !== bots.length ? ` of ${bots.length}` : ''}</span>
      </div>
      {openParam === 'enabled' && (
        <div className="row" style={{ justifyContent: 'space-between', marginBottom: 10, padding: '6px 10px', borderRadius: 7, background: 'rgba(0,208,156,.08)', border: '1px solid rgba(0,208,156,.25)' }}>
          <span>Showing your <b>{enabledCount}</b> active bot(s), expanded.</span>
          <button onClick={() => setParams({})}>Show all bots</button>
        </div>
      )}
      {shown.length === 0 && <div className="muted">No bots match the filter.</div>}
      {shown.map((b) => {
        const isTarget = botParam != null && String(b.id) === botParam;
        const defaultOpen = openParam === 'all' || (openParam === 'enabled' && !!b.enabled) || isTarget;
        return <BotRow key={b.id} bot={b} health={health.data} reload={reload} defaultOpen={defaultOpen} focus={isTarget} autoEdit={isTarget && editParam} />;
      })}
    </Card>
    </>
  );
}
