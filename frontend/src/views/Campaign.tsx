import { useState } from 'react';
import { Campaign, SeedCampaign, CampaignSnapshot } from '../api/client';
import { Card, Badge, Progress, money, signClass, useAsync, Info } from '../components/ui';
import { EquityChart } from '../components/svgcharts';
import BotWizard, { type BotPreset } from '../components/BotWizard';
import { Icon } from '../components/icons';

function fmtDate(d: any) { return d ? new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '—'; }

export default function CampaignView() {
  const { data, loading, reload } = useAsync<any>(Campaign, [], 15000);
  const [wizard, setWizard] = useState<BotPreset | null>(null);
  const [dep, setDep] = useState('');

  if (loading) return <Card><div className="muted">Loading campaign…</div></Card>;
  if (data?.armed) {
    return (
      <Card title={<span className="icon-btn"><Icon name="growth" size={16} /> Growth Campaign — ARMED</span>}>
        <div className="stack" style={{ gap: 8 }}>
          <div style={{ fontSize: 15 }}><b>{money(data.rh_equity)}</b> in Robinhood → target <b>{money(data.target_equity)}</b></div>
          <Badge kind="amber">Waiting for your deposit</Badge>
          <div className="muted" style={{ fontSize: 13, maxWidth: 640 }}>{data.note}</div>
          <div className="muted" style={{ fontSize: 12 }}>The moment a deposit (≥$25) syncs from Robinhood, the campaign starts itself: start equity = the actual deposit, the 6-month clock starts that day, milestones recompute from the real number. You'll get an alert when it goes live.</div>
        </div>
      </Card>
    );
  }
  if (!data || data.active === false) {
    return (
      <Card title="Growth Campaign">
        <div className="muted" style={{ marginBottom: 10 }}>No active campaign yet.</div>
        <button className="primary" onClick={() => SeedCampaign().then(reload)}>Start the $1k → $100k campaign</button>
      </Card>
    );
  }

  const p = data.progress || {};
  const phase = p.current_phase || {};
  const phases = data.phases || [];
  const milestones = data.milestones || [];
  const snaps = data.snapshots || [];
  const equity = Number(p.equity || 0);
  const curve = snaps.length ? snaps.map((s: any) => Number(s.equity)) : [Number(data.start_equity)];
  const dates = snaps.length ? snaps.map((s: any) => new Date(s.snap_date).getTime()) : undefined;

  const launch = (b: any) => setWizard({ name: b.name, symbols: b.symbols, asset_class: b.asset_class, rules: b.rules, action: b.action, mode: 'observe' });
  const logSnapshot = async () => { await CampaignSnapshot({ deposits: dep ? Number(dep) : 0 }); setDep(''); reload(); };

  return (
    <div className="grid" style={{ gap: 14 }}>
      {/* ── Headline progress ─────────────────────────────────────────── */}
      <Card title={<span className="icon-btn"><Icon name="growth" size={18} /> {data.name}</span>} right={<Badge kind={p.pace === 'ahead' ? 'green' : 'amber'}>{p.pace === 'ahead' ? 'AHEAD of pace' : 'BEHIND pace'}</Badge>}>
        <div className="grid cols-4" style={{ marginBottom: 12 }}>
          <Stat label="Account value" value={money(equity)} />
          <Stat label="Goal" value={money(data.target_equity)} sub={`${p.multiple_to_go}× to go`} />
          <Stat label="On-track today" value={money(p.onTrack)} sub={`${p.pace_delta >= 0 ? '+' : ''}${money(p.pace_delta)} vs pace`} cls={signClass(p.pace_delta)} info="pace" />
          <Stat label="Days left" value={String(p.days_left)} sub={`of ${p.days_elapsed + p.days_left}`} />
        </div>
        <div style={{ marginBottom: 6 }} className="row">
          <span className="muted" style={{ fontSize: 12 }}>{p.pct_to_goal}% of goal</span>
          <span className="muted" style={{ fontSize: 12, marginLeft: 'auto' }}>Phase {phase.phase} · {phase.name}<Info topic="phase" /></span>
        </div>
        <Progress value={p.pct_to_goal} kind={p.pace === 'ahead' ? 'green' : 'amber'} />

        {/* Milestone ladder */}
        <div className="row" style={{ gap: 4, marginTop: 12, flexWrap: 'wrap' }}>
          {milestones.map((m: any) => {
            const hit = equity >= m.target;
            return (
              <span key={m.level} className={`pill icon-btn ${hit ? 'green' : ''}`} title={m.label} style={{ opacity: hit ? 1 : 0.55 }}>
                {hit ? <Icon name="check" size={13} /> : null}{money(m.target)}
              </span>
            );
          })}
        </div>
      </Card>

      {/* ── Today's coaching ──────────────────────────────────────────── */}
      <Card title="Today's plan & coaching" right={
        <div className="row" style={{ gap: 6 }}>
          <input placeholder="$ deposited" style={{ width: 100 }} value={dep} onChange={(e) => setDep(e.target.value)} />
          <button onClick={logSnapshot} title="Record today's equity + any cash you added">Log day</button>
        </div>
      }>
        <div style={{ lineHeight: 1.5 }}>{p.recommendation}</div>
      </Card>

      {/* ── Thesis / research ─────────────────────────────────────────── */}
      <Card title="The thesis (why this can work in H2 2026)">
        <div style={{ lineHeight: 1.6 }}>{data.thesis}</div>
        {Array.isArray(data.sources) && data.sources.length > 0 && (
          <div className="muted" style={{ fontSize: 12, marginTop: 8 }}>
            Sources: {data.sources.map((s: string, i: number) => <a key={i} href={s} target="_blank" rel="noreferrer" style={{ marginRight: 8 }}>[{i + 1}]</a>)}
          </div>
        )}
      </Card>

      {/* ── Catalyst calendar ─────────────────────────────────────────── */}
      {Array.isArray(data.rules?.catalysts) && data.rules.catalysts.length > 0 && (
        <Card title="Catalyst calendar — the dates we trade around">
          <table>
            <thead><tr><th>Date</th><th>Event</th><th>Why it matters</th></tr></thead>
            <tbody>
              {data.rules.catalysts.map((c: any, i: number) => (
                <tr key={i}>
                  <td style={{ whiteSpace: 'nowrap' }}><b>{c.date}</b></td>
                  <td>{c.event}</td>
                  <td className="muted" style={{ fontSize: 12 }}>{c.note}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}

      {/* ── Equity track ──────────────────────────────────────────────── */}
      <Card title="Account growth (tracked daily)">
        {snaps.length < 2 ? (
          <div className="muted">Once the account is funded and a few days pass, your equity curve vs. the target pace shows here. Use “Log day” to record a manual snapshot.</div>
        ) : (
          <EquityChart curve={curve} dates={dates} height={200} />
        )}
        {snaps.length > 0 && (
          <table style={{ marginTop: 10 }}>
            <thead><tr><th>Date</th><th>Equity</th><th>+ Added</th><th>Day P/L</th><th>Total P/L</th><th>On-track</th><th>Phase</th></tr></thead>
            <tbody>
              {[...snaps].reverse().slice(0, 14).map((s: any) => (
                <tr key={s.id}>
                  <td>{fmtDate(s.snap_date)}</td>
                  <td><b>{money(s.equity)}</b></td>
                  <td className="muted">{Number(s.deposits) ? money(s.deposits) : '—'}</td>
                  <td className={signClass(s.pnl_day)}>{money(s.pnl_day)}</td>
                  <td className={signClass(s.pnl_total)}>{money(s.pnl_total)}</td>
                  <td className="muted">{money(s.target_equity_today)}</td>
                  <td className="muted">{s.phase}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      {/* ── Phase playbooks with bot setup CTAs ───────────────────────── */}
      <Card title="The plan — 4 phases (risk tightens as the account grows)">
        <div className="grid" style={{ gap: 12 }}>
          {phases.map((ph: any) => {
            const active = ph.phase === phase.phase;
            return (
              <div key={ph.phase} className="card" style={{ borderColor: active ? 'var(--green)' : 'var(--border)', background: active ? 'rgba(0,208,156,.06)' : undefined }}>
                <div className="row" style={{ justifyContent: 'space-between' }}>
                  <h3 style={{ margin: 0 }}>Phase {ph.phase}: {ph.name} {active && <Badge kind="green">YOU ARE HERE</Badge>}</h3>
                  <span className="muted">{money(ph.range[0])} → {ph.range[1] >= 1e9 ? money(data.target_equity) + '+' : money(ph.range[1])}</span>
                </div>
                <div style={{ margin: '6px 0' }}>{ph.objective}</div>
                <div className="row" style={{ gap: 6, flexWrap: 'wrap', margin: '6px 0' }}>
                  <Badge kind="blue">≤{ph.max_risk_per_trade_pct}% risk/trade</Badge>
                  <Badge kind="blue">≤{ph.max_trades} open</Badge>
                  <Badge kind="red">stop −{ph.stop_premium_pct}%</Badge>
                  <Badge kind="green">scale +{ph.take_profit_pct}%</Badge>
                  <Badge kind="gray">{ph.dte}</Badge>
                  <Badge kind="gray">{ph.delta}</Badge>
                </div>
                <div className="muted" style={{ fontSize: 13, lineHeight: 1.5, margin: '6px 0' }}>{ph.playbook}</div>
                <div style={{ marginTop: 8 }}>
                  <div style={{ fontWeight: 600, fontSize: 12, marginBottom: 4 }}>Bots for this phase:</div>
                  {(ph.bots || []).map((b: any) => (
                    <div key={b.key} className="row" style={{ justifyContent: 'space-between', padding: '6px 0', borderTop: '1px solid var(--border)' }}>
                      <div>
                        <b>{b.name}</b> <span className="muted">— {b.why}</span>
                        <div style={{ fontSize: 11, marginTop: 2 }}>
                          {(b.symbols || []).map((s: string) => <a key={s} href={`#/ticker/${s}`} className="pill" style={{ marginRight: 4 }}>{s}</a>)}
                        </div>
                      </div>
                      <button className={active ? 'primary' : ''} onClick={() => launch(b)}>Set up →</button>
                    </div>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      </Card>

      {/* ── Hard rules ────────────────────────────────────────────────── */}
      <Card title="Hard rules (always on)">
        <ul style={{ lineHeight: 1.7, margin: 0, paddingLeft: 18 }}>
          <li><b>Defined risk only</b> — long calls/puts or debit spreads. Never naked short options.</li>
          <li><b>Long-only, no crypto</b> — enforced by the risk engine on every order.</li>
          <li><b>Size off current equity</b> — risk the phase % of what the account is worth <i>today</i>, not the starting $1k.</li>
          <li><b>Daily loss halt</b> — stop trading for the day after a −{data.rules?.daily_loss_halt_pct ?? 15}% account drawdown.</li>
          <li><b>Never average down</b> — a losing thesis gets cut at the stop, not doubled.</li>
          <li><b>Bank winners</b> — take partials at the phase target; trail the rest. Don’t let green go red.</li>
        </ul>
      </Card>

      {wizard && <BotWizard preset={wizard} onClose={() => setWizard(null)} onCreated={() => { setWizard(null); reload(); }} />}
    </div>
  );
}

function Stat({ label, value, sub, cls, info }: { label: string; value: string; sub?: string; cls?: string; info?: string }) {
  return (
    <div>
      <div className="muted" style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: '.04em' }}>{label}{info && <Info topic={info} />}</div>
      <div className="stat" style={{ fontSize: 22 }}>{value}</div>
      {sub && <div className={`muted ${cls || ''}`} style={{ fontSize: 11 }}>{sub}</div>}
    </div>
  );
}
