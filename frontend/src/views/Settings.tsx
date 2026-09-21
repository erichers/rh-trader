import { useState, useEffect } from 'react';
import { RhStatus, RhAuthStart, RhSync, SetMode, SetKill, RiskLimits, SetRiskLimits, TradeDefaults, SetTradeDefaults, SetJev, SetMuse } from '../api/client';
import { RISK_FIELDS, fmtField, sizingLine } from '../components/risksizing';
import { Card, Badge, useAsync, Info, money } from '../components/ui';
import { Icon } from '../components/icons';
import { jevLastText, museTuneText } from '../modelCopy';
import { KILL_ENGAGE_CONFIRM, killEngageNeedsConfirm } from '../deskChrome';

const MODE_DESC: [string, string, string][] = [
  ['observe', 'Observe', 'Logs what every bot/Claude would do. Places NO real orders.'],
  ['cautious', 'Cautious', 'Stages every order for your one-click approval (Orders page).'],
  ['auto', 'Auto', 'Bots auto-execute when rules + the risk engine pass.'],
  ['full_auto', 'Full-Auto', 'Auto + Claude may open NEW positions within the guardrails.'],
];

export default function Settings({ health, onChange }: { health: any; onChange: () => void }) {
  const rh = useAsync<any>(RhStatus, [], 6000);
  const [busy, setBusy] = useState(false);

  const env = health?.env || 'alpaca_paper';
  const broker = health?.broker || {};
  return (
    <div className="grid" style={{ gap: 14 }}>
      <Card title="Trading environment">
        <div className="row">
          <span className={`env-badge ${health?.live ? 'live' : 'paper'}`}><span className="dot" />{env}</span>
          <span className="muted">
            {health?.live ? 'REAL MONEY — orders hit your live account.' : 'Paper — fake money, real market data. Safe for testing.'}
          </span>
        </div>
        <div className="muted" style={{ marginTop: 8, fontSize: 12 }}>
          Broker: <b>{broker.kind}</b> · ready: {broker.ready ? <Icon name="check" size={13} /> : <Icon name="x" size={13} />} ·
          Alpaca configured: {broker.alpacaConfigured ? <Icon name="check" size={13} /> : <Icon name="x" size={13} />} ·
          Robinhood: {broker.robinhood}
        </div>
        <div className="muted" style={{ marginTop: 6, fontSize: 11 }}>
          Switch environments from the top bar (a confirmation is required before going live).
          Market data (bars/indicators) always comes from Alpaca.
        </div>
      </Card>

      <Card title="Broker">
        {env !== 'robinhood_live' ? (
          <div className="muted" style={{ fontSize: 13, lineHeight: 1.45 }}>
            Alpaca paper. The book syncs from Alpaca. Live broker setup stays off this desk.
          </div>
        ) : (
          <div className="muted" style={{ fontSize: 13, lineHeight: 1.45 }}>
            <span className={`dot ${rh.data?.status === 'connected' ? 'green' : rh.data?.status === 'needs_auth' ? 'amber' : 'red'}`} />
            {' '}{rh.data?.status || '…'}
            {' · '}
            <button type="button" className="quiet-link" disabled={busy} onClick={async () => {
              const ok = window.confirm('Open live broker setup? This starts account authorization.');
              if (!ok) return;
              setBusy(true);
              try {
                const r: any = await RhAuthStart();
                if (r?.authUrl) window.open(r.authUrl, '_blank');
                else if (r?.alreadyConnected) await RhSync();
              } finally { setBusy(false); setTimeout(() => { rh.reload(); onChange(); }, 1500); }
            }}>{busy ? 'Opening…' : 'Broker setup'}</button>
            {' · '}
            <button type="button" className="quiet-link" disabled={busy} onClick={async () => { setBusy(true); await RhSync(); setBusy(false); }}>Sync</button>
          </div>
        )}
      </Card>

      <Card title="Execution mode">
        <div className="grid cols-2">
          {MODE_DESC.map(([key, label, desc]) => (
            <div key={key} className="card" style={{ background: 'var(--panel2)', borderColor: health?.mode === key ? 'var(--accent)' : 'var(--border)' }}>
              <div className="row" style={{ justifyContent: 'space-between' }}>
                <b>{label}</b>
                {health?.mode === key ? <Badge kind="green">active</Badge> : <button onClick={async () => { await SetMode(key); onChange(); }}>Set</button>}
              </div>
              <div className="muted" style={{ marginTop: 6 }}>{desc}</div>
            </div>
          ))}
        </div>
      </Card>

      <Card title="Safety">
        <div className="row">
          <button className={health?.killSwitch ? 'primary' : 'danger'} onClick={async () => {
            const engaged = !!health?.killSwitch;
            if (killEngageNeedsConfirm(engaged) && !window.confirm(KILL_ENGAGE_CONFIRM)) return;
            await SetKill(!engaged);
            onChange();
          }}>
            {health?.killSwitch ? 'Release kill switch' : 'Engage KILL SWITCH'}
          </button>
          <span className="muted">Kill switch blocks ALL order placement regardless of mode.</span>
        </div>
        <div style={{ marginTop: 12 }}>
          <div className="muted">Permanent guardrails (always on):</div>
          <ul className="muted" style={{ marginTop: 4 }}>
            <li><b>No cryptocurrency</b> — hard-vetoed by asset class and symbol, in every mode.</li>
            <li><b>Long only</b> — no short selling; sells can't exceed held quantity.</li>
            <li>Trades occur only in the isolated Robinhood Agentic account.</li>
          </ul>
        </div>
      </Card>

      <Card title="Jev: entry and exit panel" right={<a href="#/models/jev">Open Jev page →</a>}>
        <div className="muted" style={{ fontSize: 12, marginBottom: 8 }}>
          Lightning panel after a bot fires, and on open paper options when that bot's exit scope is on.
          Hard rails (kill switch, hard stop, gain-lock, trail) always win.
          <b> off</b> never calls TypeSafe. <b> shadow</b> logs and does not change the order.
          <b> active</b> may skip or size down an entry, or exit or tighten, only if that bot is switched on.
          Each bot defaults off. Weak confidence, a missing key, or an API error sizes an entry down and does not sell.
        </div>
        <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
          {(['off', 'shadow', 'active'] as const).map((m) => {
            const cur = !health?.jev?.enabled || health?.jev?.mode === 'off' ? 'off' : health?.jev?.mode;
            return (
              <button key={m} className={cur === m ? 'primary' : ''} onClick={async () => {
                await SetJev(m === 'off' ? { enabled: false, mode: 'off' } : { enabled: true, mode: m });
                onChange();
              }}>{m}</button>
            );
          })}
        </div>
        <div className="muted" style={{ marginTop: 8, fontSize: 12 }}>
          spent ${Number(health?.jev?.spentUsd || 0).toFixed(4)} / ${health?.jev?.budgetUsd ?? 5}
          {health?.jev?.degraded ? ` · degraded: ${health?.jev?.reason || 'yes'}` : ''}
        </div>
        {jevLastText(health?.jev?.last) && <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>{jevLastText(health?.jev?.last)}</div>}
      </Card>

      <Card title="Muse: auditor and improver" right={<a href="#/models/muse">Open Muse page →</a>}>
        <div className="muted" style={{ fontSize: 12, marginBottom: 8 }}>
          Muse never places orders. <b>observe</b> watches only.
          <b> improve</b> (paper default) clamps SL≤10 / TP toward 20 / trail 8–15 and may nudge min_matches / cooldown.
          No Muse key → local heuristic still runs in improve (not stuck on n/a).
        </div>
        <div className="row" style={{ gap: 8 }}>
          {(['observe', 'improve'] as const).map((m) => (
            <button key={m} className={(health?.watch?.mode || 'improve') === m ? 'primary' : ''} onClick={async () => {
              await SetMuse({ mode: m });
              onChange();
            }}>{m}</button>
          ))}
          <span className="muted" style={{ fontSize: 12 }}>
            configured: {health?.watch?.via === 'muse' && health?.watch?.available ? 'yes' : 'no (local)'}
          </span>
        </div>
        <div className="muted" style={{ marginTop: 8, fontSize: 12 }}>
          {health?.watch?.note || 'Muse never places.'}
          {museTuneText(health?.watch?.lastTune) ? ` · ${museTuneText(health?.watch?.lastTune)}` : ''}
        </div>
      </Card>

      <Card title="AI research + chat" right={<a href="#/models/ai">Open AI page →</a>}>
        <div className="muted" style={{ fontSize: 12 }}>
          Sidebar label: <b>{health?.aiShort || 'no key'}</b>. Research vs chat comes from the live
          provider chain (usually Kimi + Groq). Keys stay in <code>.env</code> — this page never shows them.
        </div>
        <div className="muted" style={{ marginTop: 6, fontSize: 12 }}>{health?.aiLabel || 'AI label unavailable until the API is up.'}</div>
      </Card>

      <TradeSizingCard />
      <RiskLimitsCard />
    </div>
  );
}

const LIMITS: { key: string; label: string; suffix: string; info: string; money?: boolean }[] = [
  { key: 'maxConcentrationPct', label: 'Max concentration', suffix: '% of equity', info: 'The most of your account equity that can sit in ONE symbol across every bot. A buy is vetoed if the combined book (held + today\'s in-flight + same-cycle tickets) would push that symbol over this. Default paper desk is 25%.' },
  { key: 'maxPositionUsd', label: 'Max position size', suffix: '$ per symbol', info: 'Hardest dollar cap on the combined position in one symbol (all bots, options ×100) — not only the ticket in hand. Three META tickets that each sit under the cap still fail if together they would exceed it.', money: true },
  { key: 'maxDailyLossPct', label: 'Daily-loss halt', suffix: '% drawdown', info: 'If the account draws down this % from its start-of-day equity, all new orders are vetoed for the rest of the day. Your circuit breaker.' },
  { key: 'maxOrdersPerDay', label: 'Max buys / day', suffix: 'orders', info: 'Throttle on new BUY orders per day (per env). Sells/exits are never throttled, so you can always close.' },
];

function RiskLimitsCard() {
  const { data, reload } = useAsync<any>(RiskLimits, [], 0);
  const [form, setForm] = useState<Record<string, string>>({});
  const [saved, setSaved] = useState(false);
  const [err, setErr] = useState('');
  useEffect(() => { if (data?.limits) setForm(Object.fromEntries(LIMITS.map((l) => [l.key, String(data.limits[l.key])]))); }, [data]);
  if (!data) return <Card title="Risk limits"><div className="muted">Loading…</div></Card>;

  const save = async () => {
    setErr('');
    const body: any = {};
    for (const l of LIMITS) if (form[l.key] !== '' && form[l.key] != null) body[l.key] = Number(form[l.key]);
    try { await SetRiskLimits(body); setSaved(true); setTimeout(() => setSaved(false), 1800); reload(); }
    catch (e: any) { setErr('Save failed: ' + String(e)); }
  };
  const resetField = (k: string) => setForm((f) => ({ ...f, [k]: String(data.defaults[k]) }));

  return (
    <Card title={<>Risk limits — adjustable<Info text="These tune the deterministic risk engine that gates every order (manual, bot, and AI). Changes apply immediately and live in the DB; .env only sets the initial defaults." /></>}
      right={saved ? <Badge kind="green"><span className="icon-btn">saved <Icon name="check" size={13} /></span></Badge> : <button className="primary" onClick={save}>Save limits</button>}>
      {err && <div className="red" style={{ marginBottom: 8 }}>{err}</div>}
      <div className="grid cols-2" style={{ gap: 12 }}>
        {LIMITS.map((l) => {
          const cur = data.limits[l.key]; const def = data.defaults[l.key]; const changed = Number(form[l.key]) !== Number(cur);
          return (
            <div key={l.key} className="card" style={{ background: 'var(--panel2)' }}>
              <div className="row" style={{ justifyContent: 'space-between' }}>
                <b>{l.label}<Info text={l.info} /></b>
                <span className="muted" style={{ fontSize: 11 }}>now {l.money ? money(cur) : `${cur}${l.suffix.startsWith('%') ? '%' : ''}`}</span>
              </div>
              <div className="row" style={{ marginTop: 6, gap: 6 }}>
                <input type="number" min={1} step={l.money ? 50 : 1} value={form[l.key] ?? ''} onChange={(e) => setForm((f) => ({ ...f, [l.key]: e.target.value }))} style={{ width: 110 }} aria-label={l.label} />
                <span className="muted" style={{ fontSize: 12 }}>{l.suffix}</span>
                {changed && <button onClick={() => resetField(l.key)} style={{ fontSize: 11, padding: '2px 7px' }}>reset</button>}
              </div>
              <div className="muted" style={{ fontSize: 11, marginTop: 4 }}>default {l.money ? money(def) : def}</div>
            </div>
          );
        })}
      </div>
      <div className="muted icon-btn" style={{ fontSize: 12, marginTop: 10, alignItems: 'flex-start' }}>
        <Icon name="focus" size={15} /> <span>Trading one ticker all day in <b>Focus mode</b>? Raise <b>Max concentration</b> (e.g. to 80–100%) so the cap doesn't veto a heavy single-name position. Higher concentration = higher risk if that name moves against you.</span>
      </div>
    </Card>
  );
}

/** Global sizing + exits: the money that goes into one trade and where it gets out.
 *  Every bot inherits these unless it sets its own on the Bots page. */
function TradeSizingCard() {
  const { data, reload } = useAsync<any>(TradeDefaults, [], 0);
  const [form, setForm] = useState<Record<string, string>>({});
  const [saved, setSaved] = useState(false);
  const [err, setErr] = useState('');
  // amount_usd is opt-in: null is a real saved value ("not set"), not a missing one — a
  // blank field means that, not "leave whatever was there before".
  const fieldStr = (v: any) => (v == null ? '' : String(v));
  useEffect(() => { if (data?.trade_defaults) setForm(Object.fromEntries(RISK_FIELDS.map((f) => [f.key, fieldStr(data.trade_defaults[f.key])]))); }, [data]);
  if (!data) return <Card title="Trade sizing and exits"><div className="muted">Loading…</div></Card>;
  const cur = data.trade_defaults; const factory = data.factory;

  const save = async () => {
    setErr('');
    const body: any = {};
    for (const f of RISK_FIELDS) {
      if (form[f.key] !== '' && form[f.key] != null) body[f.key] = Number(form[f.key]);
      else if (f.key === 'amount_usd') body[f.key] = null; // blank amount is a deliberate clear
    }
    try { await SetTradeDefaults(body); setSaved(true); setTimeout(() => setSaved(false), 1800); reload(); }
    catch (e: any) { setErr('Save failed: ' + String(e)); }
  };

  return (
    <Card title={<>Trade sizing and exits<Info text="How much money goes into ONE trade, and where it exits. Every bot uses these numbers unless it sets its own (Bots page, Risk). Manual orders you place yourself are not affected." /></>}
      right={saved ? <Badge kind="green"><span className="icon-btn">saved <Icon name="check" size={13} /></span></Badge> : <button className="primary" onClick={save}>Save defaults</button>}>
      <div className="muted" style={{ marginBottom: 10, fontSize: 12 }}>
        Now in force: <b>{sizingLine(cur)}</b>. A bot sizes each entry to the amount, rounded down to whole shares or contracts.
      </div>
      {err && <div className="red" style={{ marginBottom: 8 }}>{err}</div>}
      <div className="risk-grid">
        {RISK_FIELDS.map((f) => {
          const changed = Number(form[f.key]) !== Number(cur[f.key]);
          return (
            <div key={f.key} className="risk-field">
              <label className="muted" htmlFor={`td-${f.key}`}>{f.label}<Info text={f.help} /></label>
              <div className="risk-input-row">
                <span className="risk-prefix">{f.money ? '$' : ''}</span>
                <input id={`td-${f.key}`} type="number" inputMode="decimal" min={0} step={f.money ? 50 : 1}
                  placeholder={f.placeholder} value={form[f.key] ?? ''} onChange={(e) => setForm((s) => ({ ...s, [f.key]: e.target.value }))} />
                {!f.money && <span className="muted" style={{ fontSize: 12 }}>%</span>}
              </div>
              <div className="risk-line muted">
                now {fmtField(f.key, cur[f.key])} · default {fmtField(f.key, factory[f.key])}
                {changed && <button style={{ fontSize: 11, padding: '2px 8px' }} onClick={() => setForm((s) => ({ ...s, [f.key]: fieldStr(cur[f.key]) }))}>undo</button>}
                {Number(form[f.key]) !== Number(factory[f.key]) && <button style={{ fontSize: 11, padding: '2px 8px' }} onClick={() => setForm((s) => ({ ...s, [f.key]: fieldStr(factory[f.key]) }))}>reset to default</button>}
              </div>
            </div>
          );
        })}
      </div>
      <div className="muted" style={{ fontSize: 12, marginTop: 10, lineHeight: 1.5 }}>
        Take profit 0 is deliberate: winners ride the trailing stop instead of being capped, which is where the system’s edge comes from
        (small losses, big wins). Percentages apply to the option premium for contracts and to the share price for stock.
        A trade that cannot fit between the minimum and the maximum is skipped with a written reason rather than resized past your limits.
      </div>
    </Card>
  );
}
