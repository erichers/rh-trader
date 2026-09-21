import { useEffect, useState } from 'react';
import { Link, NavLink, useParams } from 'react-router-dom';
import { AiModels, GetJev, GetMuse, SetBotJev, SetJev, SetMuse } from '../api/client';
import { JEV_CADENCE_FALLBACK, JEV_EMPTY_PICK, jevLastText, jevSkipLabel, museTuneText } from '../modelCopy';
import { Badge, Card, fmtDateTime } from '../components/ui';

export type ModelId = 'jev' | 'muse' | 'ai';

const MODELS: { id: ModelId; title: string; role: string; blurb: string }[] = [
  {
    id: 'jev',
    title: 'Jev',
    role: 'Post-signal panel',
    blurb: 'TypeSafe check after a bot fires, and on open paper options when that bot allows it. Hard rails always win.',
  },
  {
    id: 'muse',
    title: 'Muse',
    role: 'Auditor / improver',
    blurb: 'Watches open positions and armed bots. Can tighten paper exits. Never places an order.',
  },
  {
    id: 'ai',
    title: 'AI research + chat',
    role: 'Desk models',
    blurb: 'Research (usually Kimi) writes theses. Chat (usually Groq) answers questions. Keys live in Settings.',
  },
];

function parseAiLabel(label: string | undefined): { research: string; chat: string; missing: string } {
  const raw = String(label || '');
  const research = (raw.match(/research:\s*([^·]+)/i)?.[1] || '').trim() || 'none';
  const chat = (raw.match(/chat:\s*([^·]+)/i)?.[1] || '').trim() || 'none';
  const missing = (raw.match(/NO PROVIDER for:\s*(.+)$/i)?.[1] || '').trim();
  return { research, chat, missing };
}

function sanitizeProbeError(err: unknown): string | null {
  const s = String(err || '').trim();
  if (!s) return null;
  if (/sk-|gsk_|Bearer |api[_-]?key/i.test(s)) return 'provider error (hidden — may contain a secret)';
  return s.slice(0, 160);
}

function jevModeOf(health: any): 'off' | 'shadow' | 'active' {
  if (!health?.jev?.enabled || health?.jev?.mode === 'off') return 'off';
  return health.jev.mode === 'active' ? 'active' : 'shadow';
}

export default function ModelsView({ health, onChange }: { health: any; onChange: () => void }) {
  const { which } = useParams();
  const id = (which === 'jev' || which === 'muse' || which === 'ai') ? which : null;

  return (
    <div className="grid" style={{ gap: 16 }}>
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'baseline' }}>
        <div>
          <div className="muted" style={{ fontSize: 11, letterSpacing: 0.8, textTransform: 'uppercase', fontWeight: 700 }}>
            Desk models
          </div>
          <h2 style={{ margin: '4px 0 0' }}>{id ? MODELS.find((m) => m.id === id)?.title : 'Models'}</h2>
        </div>
        <div className="row" style={{ gap: 8 }}>
          {MODELS.map((m) => (
            <NavLink key={m.id} to={`/models/${m.id}`} className={({ isActive }) => `pill${isActive ? ' on' : ''}`}>
              {m.title}
            </NavLink>
          ))}
          <Link to="/settings" className="muted" style={{ fontSize: 12 }}>Settings →</Link>
        </div>
      </div>

      {!id && <ModelsHub health={health} />}
      {id === 'jev' && <JevDetail health={health} onChange={onChange} />}
      {id === 'muse' && <MuseDetail health={health} onChange={onChange} />}
      {id === 'ai' && <AiDetail health={health} />}
    </div>
  );
}

function ModelsHub({ health }: { health: any }) {
  const j = health?.jev;
  const w = health?.watch;
  const ai = parseAiLabel(health?.aiLabel);
  return (
    <>
      <p className="muted" style={{ marginTop: 0, maxWidth: 640, lineHeight: 1.5 }}>
        Three optional helpers sit beside the rails. Click a name in the sidebar, Jev, Muse, or AI,
        to tune it here. None of them can place a live order. Options-only law is unchanged.
      </p>
      <div className="grid cols-3">
        <HubCard to="/models/jev" title="Jev" role="Post-signal panel"
          dot={!j || !j.enabled || j.mode === 'off' ? 'gray' : j.degraded ? 'red' : j.mode === 'active' && j.ok ? 'green' : 'amber'}
          status={!j || !j.enabled || j.mode === 'off' ? 'off' : `${j.mode} · $${Number(j.spentUsd || 0).toFixed(2)}/$${j.budgetUsd ?? 5}`}
          body="After a bot fires, Jev can enter, skip, or size down. On an open option it can hold, exit, or tighten when that bot's exit switch is on. Off never calls TypeSafe." />
        <HubCard to="/models/muse" title="Muse" role="Auditor / improver"
          dot={w?.lastError ? 'amber' : (w?.mode === 'improve' && (w.ok || w.running || w.lastCycle) ? (w.running ? 'green' : 'amber') : (w?.available && w?.running ? 'green' : 'gray'))}
          status={`${w?.mode || 'improve'} · ${w?.via || 'local'}${museTuneText(w?.lastTune) ? ` · ${museTuneText(w?.lastTune)}` : ''}`}
          body="Muse reviews packets and can clamp paper stops toward the swing law. It never sends an order." />
        <HubCard to="/models/ai" title="AI" role="Research + chat"
          dot={health?.ai ? 'green' : 'gray'}
          status={health?.aiShort || 'no key'}
          body={`Research: ${ai.research}. Chat: ${ai.chat}. Add keys in Settings — this page never shows secrets.`} />
      </div>
    </>
  );
}

function HubCard({ to, title, role, dot, status, body }: { to: string; title: string; role: string; dot: string; status: string; body: string }) {
  return (
    <Link to={to} className="card model-hub-card">
      <div className="muted" style={{ fontSize: 11, letterSpacing: 0.6, textTransform: 'uppercase' }}>{role}</div>
      <div className="row" style={{ justifyContent: 'space-between', marginTop: 6 }}>
        <b style={{ fontSize: 20 }}>{title}</b>
        <span className={`dot ${dot}`} />
      </div>
      <div className="muted" style={{ marginTop: 8, fontSize: 12 }}>{status}</div>
      <p style={{ margin: '10px 0 0', fontSize: 13, lineHeight: 1.45, color: 'var(--text)' }}>{body}</p>
    </Link>
  );
}

function JevDetail({ health, onChange }: { health: any; onChange: () => void }) {
  const [live, setLive] = useState<any>(null);
  const [err, setErr] = useState('');
  const [status, setStatus] = useState<'loading' | 'ok' | 'down'>('loading');
  const reload = () => GetJev().then((row) => { setLive(row); setErr(''); setStatus('ok'); }).catch(() => { setLive(null); setStatus('down'); });
  useEffect(() => { reload(); }, [health?.jev]);
  const j = live || health?.jev || {};
  const cur = jevModeOf({ jev: j });
  const entry = j.lastEntry || (j.last?.kind === 'exit' ? null : j.last);
  const exit = j.lastExit || null;
  const bots = Array.isArray(j.bots) ? j.bots : [];
  const decisions = Array.isArray(j.decisions) ? j.decisions : [];
  const cadence = Array.isArray(j.cadence) && j.cadence.length ? j.cadence : JEV_CADENCE_FALLBACK;

  const setMode = async (m: 'off' | 'shadow' | 'active') => {
    await SetJev(m === 'off' ? { enabled: false, mode: 'off' } : { enabled: true, mode: m });
    onChange();
    reload();
  };

  const setBot = async (bot: any, patch: { entry?: boolean; exit?: boolean }) => {
    setErr('');
    const next = { entry: !!bot.jev?.entry, exit: !!bot.jev?.exit, ...patch };
    setLive((curLive: any) => {
      if (!curLive?.bots) return curLive;
      return {
        ...curLive,
        bots: curLive.bots.map((b: any) => b.id === bot.id ? { ...b, jev: next } : b),
      };
    });
    try {
      await SetBotJev(bot.id, patch);
      onChange();
      reload();
    } catch (e: any) {
      setErr(String(e?.message || e).slice(0, 160));
      reload();
    }
  };

  return (
    <div className="jev-page">
      <Card>
        <div className="model-brief">
          <span className="model-tape">TypeSafe · entry and exit</span>
          <p>
            Jev advises a new long call (enter, skip, or size down) and, when that bot's exit scope is on,
            an open paper option (hold, exit, or tighten). It is not a price predictor.
          </p>
          <p>
            The hard stop and the +1.5% gain-lock always win. Global mode is off, shadow, or active.
            Each bot defaults off. Jev acts only on Alpaca paper, and only when global mode is active
            and that scope is on. Off still logs a shadow decision and does not call TypeSafe.
          </p>
        </div>
      </Card>

      <Card title="Live status" right={<Badge kind={cur === 'off' ? 'gray' : j.degraded ? 'red' : cur === 'active' ? 'green' : 'amber'}>{cur}</Badge>}>
        <div className="jev-stats">
          <Stat label="Mode" value={cur} />
          <Stat label="Spend" value={`$${Number(j.spentUsd || 0).toFixed(4)} / $${j.budgetUsd ?? 5}`} />
          <Stat label="TypeSafe key" value={j.configured ? 'configured' : 'not set'} />
          <Stat label="Acts on" value="Alpaca paper" />
        </div>
        {j.degraded && <div className="amber" style={{ marginTop: 12, fontSize: 13 }}>Degraded: {j.reason || 'budget or payment'}. Entries size down. Exits stay on the rails.</div>}
        {!j.configured && cur === 'active' && <div className="muted" style={{ marginTop: 8, fontSize: 12 }}>No key: active entries size down. Exits are logged and not sold.</div>}
        <div className="jev-picks">
          <PickCard label="Entry Jev" last={entry} empty={JEV_EMPTY_PICK} />
          <PickCard label="Exit Jev" last={exit} empty={JEV_EMPTY_PICK} />
        </div>
      </Card>

      <div className="jev-split">
        <Card title="Global mode">
          <p className="muted jev-help">off never calls TypeSafe. shadow logs and does not change size or exits. active may act only for bots you switch on.</p>
          <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
            {(['off', 'shadow', 'active'] as const).map((m) => (
              <button key={m} className={cur === m ? 'primary' : ''} onClick={() => setMode(m)}>{m}</button>
            ))}
          </div>
        </Card>
        <Card title="Check cadence">
          <p className="muted jev-help">Exit checks during regular hours. A fresh decision inside the window skips the next TypeSafe call. The hard stop still runs on the monitor loop.</p>
          <div className="jev-bands">
            {cadence.map((b: any) => (
              <div key={b.band} className="jev-band">
                <div className="muted">{String(b.dte).includes('DTE') ? b.dte : `${b.dte} DTE`}</div>
                <b>{b.every}</b>
              </div>
            ))}
          </div>
        </Card>
      </div>

      <Card title="Per bot" right={<span className="muted" style={{ fontSize: 12 }}>Default off</span>}>
        <p className="muted jev-help">Off still logs a shadow decision on cadence and does not call TypeSafe. On can spend the $5 budget when a check is due. Entry and exit are separate.</p>
        {err && <div className="amber" style={{ marginBottom: 8 }}>{err}</div>}
        {!bots.length && status === 'loading' && <div className="muted">Loading bots…</div>}
        {!bots.length && status === 'down' && <div className="muted">API is down, so bot switches are not loaded. They stay off until the desk answers.</div>}
        {!bots.length && status === 'ok' && <div className="muted">No bots on this account yet. Add one on Bots, then turn a scope on here.</div>}
        {!!bots.length && (
          <table className="jev-bots">
            <thead>
              <tr><th>Bot</th><th>Symbols</th><th>Entry</th><th>Exit</th></tr>
            </thead>
            <tbody>
              {bots.map((b: any) => (
                <tr key={b.id}>
                  <td>
                    <b><Link to={`/bots?bot=${b.id}`}>{b.name}</Link></b>
                    {!b.enabled && <span className="muted"> · bot off</span>}
                  </td>
                  <td className="muted">{(b.symbols || []).slice(0, 4).join(', ') || 'any'}</td>
                  <td><ScopeToggle on={!!b.jev?.entry} label="Entry" onClick={() => setBot(b, { entry: !b.jev?.entry })} /></td>
                  <td><ScopeToggle on={!!b.jev?.exit} label="Exit" onClick={() => setBot(b, { exit: !b.jev?.exit })} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      <Card title={decisions.length ? `Last ${decisions.length} decisions` : 'Last decisions'}>
        <p className="muted jev-help">Exit picks are CLOSE, PARTIAL, HOLD, or TIGHTEN_TRAIL. Wave-1 stays off until you turn a candidate on. Paper only. Applied means global active, that scope was on, and the desk is on Alpaca paper. Off still logs.</p>
        {!decisions.length && status === 'down' && <div className="muted">Decision log needs the API.</div>}
        {!decisions.length && status !== 'down' && <div className="muted">No decisions yet.</div>}
        {!!decisions.length && (
          <table className="jev-log">
            <thead>
              <tr><th>When</th><th>Kind</th><th>Pick</th><th>Symbol</th><th>Bot</th><th>Acted</th></tr>
            </thead>
            <tbody>
              {decisions.map((d: any, i: number) => (
                <tr key={`${d.at}-${i}`}>
                  <td className="muted">{d.at ? fmtDateTime(d.at) : ''}</td>
                  <td>{d.kind || ''}</td>
                  <td><b>{d.pick || 'none'}</b></td>
                  <td>{d.symbol || ''}</td>
                  <td className="muted">{d.bot || ''}</td>
                  <td>{d.applied ? <span className="green">yes</span> : <span className="muted">{jevSkipLabel(d.skipped)}</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </div>
  );
}

function PickCard({ label, last, empty }: { label: string; last: any; empty: string }) {
  const text = jevLastText(last);
  return (
    <div className="jev-pick">
      <div className="muted jev-kicker">{label}</div>
      {text ? <div className="jev-pick-body">{text}</div> : <div className="muted">{empty}</div>}
      {last?.applied === false && <div className="muted" style={{ marginTop: 6, fontSize: 12 }}>Logged, not applied{last?.skipped ? ` (${jevSkipLabel(last.skipped)})` : ''}.</div>}
      {last?.at && <div className="muted" style={{ marginTop: 6, fontSize: 11 }}>{fmtDateTime(last.at)}</div>}
    </div>
  );
}

function ScopeToggle({ on, label, onClick }: { on: boolean; label: string; onClick: () => void }) {
  return (
    <button type="button" className={`jev-switch${on ? ' on' : ''}`} aria-pressed={on} aria-label={`${label} ${on ? 'on' : 'off'}`} onClick={onClick}>
      <span>{label}</span>
      <span className="jev-switch-v">{on ? 'on' : 'off'}</span>
    </button>
  );
}

function MuseDetail({ health, onChange }: { health: any; onChange: () => void }) {
  const [live, setLive] = useState<any>(null);
  useEffect(() => { GetMuse().then(setLive).catch(() => setLive(null)); }, [health?.watch]);
  const w = live?.watch || health?.watch || {};
  const mode = (live?.mode || w.mode || 'improve') === 'observe' ? 'observe' : 'improve';
  const tune = live?.lastTune || w.lastTune;

  return (
    <>
      <Card>
        <div className="model-brief">
          <span className="model-tape">Auditor · never places</span>
          <p>
            Muse walks open positions and armed bots on a timer. It can <b>flag</b> a packet
            and, in improve mode, tighten paper bot config toward the swing law
            (stop ≤ 10%, take-profit toward 20%, trail 8–15).
          </p>
          <p>
            Muse does not place, stage, or send outbound orders. No Muse key is required —
            the local heuristic still runs in improve, so the lamp is not stuck on n/a.
            Live open-position stops are never widened.
          </p>
        </div>
      </Card>

      <Card title="Live status" right={<Badge kind={w.lastError ? 'amber' : mode === 'improve' ? 'green' : 'gray'}>{mode}</Badge>}>
        <div className="grid cols-3" style={{ gap: 12 }}>
          <Stat label="Mode" value={mode} />
          <Stat label="Via" value={w.via === 'muse' && w.available ? 'Muse API' : 'local heuristic'} />
          <Stat label="Cycle" value={w.running ? 'running' : (w.lastCycle ? 'idle' : 'waiting')} />
        </div>
        <div className="muted" style={{ marginTop: 10, fontSize: 13 }}>
          {w.note || 'Muse never places.'}
          {w.lastCycle ? ` · last cycle ${fmtDateTime(w.lastCycle)}` : ''}
          {w.positions != null ? ` · ${w.positions} positions` : ''}
          {w.armedBots != null ? ` · ${w.armedBots} armed bots` : ''}
        </div>
        {w.lastError && <div className="amber" style={{ marginTop: 8 }}>{sanitizeProbeError(w.lastError)}</div>}
        {museTuneText(tune) && (
          <div style={{ marginTop: 12, padding: 12, background: 'var(--panel2)', borderRadius: 10 }}>
            <div className="muted" style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.6 }}>Last tune</div>
            <div style={{ marginTop: 4 }}><b>{museTuneText(tune)}</b>{tune?.botId != null ? ` (bot #${tune.botId}${tune?.symbol ? `, ${tune.symbol}` : ''})` : ''}</div>
            {tune?.because && <div className="muted" style={{ marginTop: 4, fontSize: 13 }}>{tune.because}</div>}
            {tune?.at && <div className="muted" style={{ marginTop: 4, fontSize: 11 }}>{fmtDateTime(tune.at)}</div>}
          </div>
        )}
      </Card>

      <Card title="Tune">
        <div className="muted" style={{ fontSize: 12, marginBottom: 8 }}>Same controls as Settings. Improve is the paper default.</div>
        <div className="row" style={{ gap: 8 }}>
          {(['observe', 'improve'] as const).map((m) => (
            <button key={m} className={mode === m ? 'primary' : ''} onClick={async () => { await SetMuse({ mode: m }); onChange(); }}>{m}</button>
          ))}
        </div>
      </Card>
    </>
  );
}

function AiDetail({ health }: { health: any }) {
  const [probe, setProbe] = useState<any>(null);
  const [err, setErr] = useState('');
  useEffect(() => {
    AiModels().then(setProbe).catch((e: any) => setErr(String(e?.message || e).slice(0, 160)));
  }, [health?.aiShort]);
  const parsed = parseAiLabel(health?.aiLabel);
  const providers = probe?.providers || {};
  const researchChain = probe?.tasks?.research || [];
  const chatChain = probe?.tasks?.chat || [];

  return (
    <>
      <Card>
        <div className="model-brief">
          <span className="model-tape">Research + chat</span>
          <p>
            The sidebar AI row is the live desk label from <code>health.aiShort</code> —
            usually <b>Kimi</b> for research theses and <b>Groq</b> for chat.
            The long form is <code>health.aiLabel</code>.
          </p>
          <p>
            This page does not invent keys or call providers. If a key is missing, add it
            in <Link to="/settings">Settings</Link> / <code>.env</code>. Secrets are never printed.
            Ask AI and Research still go through the risk engine.
          </p>
        </div>
      </Card>

      <Card title="Live status" right={<Badge kind={health?.ai ? 'green' : 'gray'}>{health?.aiShort || 'no key'}</Badge>}>
        <div className="grid cols-2" style={{ gap: 12 }}>
          <div className="card" style={{ background: 'var(--panel2)' }}>
            <div className="muted" style={{ fontSize: 11, textTransform: 'uppercase' }}>Research</div>
            <div style={{ marginTop: 6, fontSize: 16 }}><b>{parsed.research}</b></div>
            <div className="muted" style={{ marginTop: 6, fontSize: 12 }}>Theses, ticker analysis, learning ideas. Lead is often Kimi when Claude is unset.</div>
            <Link to="/research" style={{ display: 'inline-block', marginTop: 8 }}>Open Research →</Link>
          </div>
          <div className="card" style={{ background: 'var(--panel2)' }}>
            <div className="muted" style={{ fontSize: 11, textTransform: 'uppercase' }}>Chat</div>
            <div style={{ marginTop: 6, fontSize: 16 }}><b>{parsed.chat}</b></div>
            <div className="muted" style={{ marginTop: 6, fontSize: 12 }}>Ask-AI answers and short SQL-style questions. Lead is usually Groq.</div>
            <Link to="/chat" style={{ display: 'inline-block', marginTop: 8 }}>Open Ask AI →</Link>
          </div>
        </div>
        {parsed.missing && <div className="amber" style={{ marginTop: 10, fontSize: 13 }}>No provider for: {parsed.missing}</div>}
        <div className="muted" style={{ marginTop: 10, fontSize: 12 }}>{health?.aiLabel || 'AI label unavailable.'}</div>
      </Card>

      <Card title="Provider probe" right={<Link to="/settings">Keys in Settings →</Link>}>
        {err && <div className="muted" style={{ marginBottom: 8 }}>Probe API unavailable: {sanitizeProbeError(err)}</div>}
        {!probe && !err && <div className="muted">Loading provider status…</div>}
        {probe && (
          <>
            <table>
              <thead><tr><th>Provider</th><th>Configured</th><th>Live ids</th><th>Probed</th><th>Error</th></tr></thead>
              <tbody>
                {['kimi', 'groq', 'anthropic', 'nvidia', 'local'].map((name) => {
                  const p = providers[name] || {};
                  return (
                    <tr key={name}>
                      <td><b>{name}</b></td>
                      <td>{p.configured ? <span className="green">yes</span> : <span className="muted">no</span>}</td>
                      <td>{p.configured ? (p.live_ids ?? '—') : '—'}</td>
                      <td className="muted">{p.probed_at ? fmtDateTime(p.probed_at) : '—'}</td>
                      <td className="muted">{sanitizeProbeError(p.error) || '—'}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <div className="grid cols-2" style={{ marginTop: 14 }}>
              <ChainList title="Research chain" rows={researchChain} />
              <ChainList title="Chat chain" rows={chatChain} />
            </div>
          </>
        )}
      </Card>
    </>
  );
}

function ChainList({ title, rows }: { title: string; rows: { provider: string; model: string; live: boolean | null }[] }) {
  return (
    <div>
      <div className="muted" style={{ fontSize: 11, textTransform: 'uppercase', marginBottom: 6 }}>{title}</div>
      {!rows.length && <div className="muted">No configured provider on this chain.</div>}
      {rows.map((r, i) => (
        <div key={`${r.provider}-${r.model}-${i}`} className="row" style={{ justifyContent: 'space-between', padding: '4px 0' }}>
          <span>{r.provider} · {r.model}</span>
          <span className={r.live === true ? 'green' : r.live === false ? 'red' : 'muted'}>
            {r.live === true ? 'live' : r.live === false ? 'dead' : 'unprobed'}
          </span>
        </div>
      ))}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="muted" style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.6 }}>{label}</div>
      <div style={{ marginTop: 4, fontWeight: 600 }}>{value}</div>
    </div>
  );
}
