import { useState, useEffect } from 'react';
import { RhStatus, RhAuthStart, RhSync, SetMode, SetKill, RiskLimits, SetRiskLimits, TradeDefaults, SetTradeDefaults } from '../api/client';
import { RISK_FIELDS, fmtField, sizingLine } from '../components/risksizing';
import { Card, Badge, useAsync, Info, money } from '../components/ui';
import { Icon } from '../components/icons';

const MODE_DESC: [string, string, string][] = [
  ['observe', 'Observe', 'Logs what every bot or model would do. Places no real orders.'],
  ['cautious', 'Cautious', 'Stages every order for your one-click approval (Orders page).'],
  ['auto', 'Auto', 'Bots auto-execute when rules and the risk engine pass.'],
  ['full_auto', 'Full-Auto', 'Auto, and a model may open new positions within the guardrails.'],
];

export default function Settings({ health, onChange }: { health: any; onChange: () => void }) {
  const rh = useAsync<any>(RhStatus, [], 6000);
  const [busy, setBusy] = useState(false);

  const env = health?.env || 'alpaca_paper';
  const broker = health?.broker || {};
  return (
    <div className="grid" style={{ gap: 14 }}>
      <Card title="How this desk works">
        <div className="onboard-grid">
          <div>
            <div className="muted muse-k">Observe vs Paper</div>
            <p className="muted" style={{ fontSize: 13, margin: '4px 0 0' }}>
              Paper is the Alpaca account with fake money. Observe is the mode that logs and never
              sends an order. You can stay here indefinitely.
            </p>
          </div>
          <div>
            <div className="muted muse-k">Providers</div>
            <p className="muted" style={{ fontSize: 13, margin: '4px 0 0' }}>
              Muse: watch, ops, performance. NVIDIA then Groq: research and reviews. Groq: chat and
              news triage. Kimi: backup. Anthropic: optional, may be invalid.
            </p>
          </div>
          <div>
            <div className="muted muse-k">Watcher</div>
            <p className="muted" style={{ fontSize: 13, margin: '4px 0 0' }}>
              SPY, META, TSLA, QQQ. News plus indicators, Muse writes notes. No orders from that loop.
            </p>
          </div>
        </div>
      </Card>

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

      <Card title="Robinhood connection">
        <div className="row">
          <span className={`dot ${rh.data?.status === 'connected' ? 'green' : rh.data?.status === 'needs_auth' ? 'amber' : 'red'}`} />
          <b>{rh.data?.status || '…'}</b>
          <span className="muted">{rh.data?.tools?.length || 0} tools</span>
          <button className="primary" disabled={busy} onClick={async () => {
            setBusy(true);
            try {
              const r: any = await RhAuthStart();
              if (r?.authUrl) window.open(r.authUrl, '_blank');
              else if (r?.alreadyConnected) await RhSync();
            } finally { setBusy(false); setTimeout(() => { rh.reload(); onChange(); }, 1500); }
          }}>{busy ? 'Opening…' : 'Connect / set up Robinhood'}</button>
          <button disabled={busy} onClick={async () => { setBusy(true); await RhSync(); setBusy(false); }}>Sync now</button>
        </div>
        <div className="muted" style={{ marginTop: 8, fontSize: 12 }}>
          Clicking <b>Connect</b> opens Robinhood's authorization page in a new tab. After you approve, the app
          finishes setup automatically (it catches the redirect on <code>localhost:7321</code>) and links your
          Robinhood Agentic account. You can also run <code>npm run rh:auth</code> in /backend.
        </div>
        {rh.data?.lastError && <div className="red" style={{ marginTop: 6 }}>{rh.data.lastError}</div>}
        {(rh.data?.tools || []).length > 0 && (
          <div style={{ marginTop: 10 }}>
            <div className="muted">Available MCP tools:</div>
            <div className="row" style={{ marginTop: 4 }}>
              {rh.data.tools.map((t: any) => <span key={t.name} className="pill">{t.name}</span>)}
            </div>
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
          <button className={health?.killSwitch ? 'primary' : 'danger'} onClick={async () => { await SetKill(!health?.killSwitch); onChange(); }}>
            {health?.killSwitch ? '● Release kill switch' : 'Engage KILL SWITCH'}
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

      <TradeSizingCard />
      <RiskLimitsCard />
    </div>
  );
}

const LIMITS: { key: string; label: string; suffix: string; info: string; money?: boolean }[] = [
  { key: 'maxConcentrationPct', label: 'Max concentration', suffix: '% of equity', info: 'The most of your account equity that can sit in ONE symbol. A buy is vetoed if it would push that symbol (including today\'s in-flight buys) over this. Raise it to trade one ticker heavily in Focus mode — higher = more single-name risk.' },
  { key: 'maxPositionUsd', label: 'Max position size', suffix: '$ per trade', info: 'Hardest dollar cap on a single order (options counted ×100). A bot\'s own max_position_usd can only make this tighter, never looser.', money: true },
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
