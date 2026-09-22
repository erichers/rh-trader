import { Account, Bots, Pnl, Positions } from '../api/client';
import GlassCard from '../components/GlassCard';
import { money, signClass, useAsync } from '../components/ui';
import { PAPER_NEXT_STEP, PAPER_POSITIONS_EMPTY } from '../deskChrome';
import { blockedBotCount, hotConcentration, maxLossPct, openRiskPreview } from '../deskHome';
import { fmtBookPct } from '../optionBook';

function dayWindow(pnl: any): { pl: number; pct: number } | null {
  if (!pnl || pnl.source === 'unavailable') return null;
  const win = pnl.windows?.day;
  if (!win || !Number.isFinite(Number(win.pl))) return null;
  return { pl: Number(win.pl), pct: Number(win.pct) };
}

/** Glass home. Glance cards, then a short open-risk preview. No layout editor. */
export default function Dashboard({ health, monitors }: { health: any; monitors: any[] | null }) {
  const acct = useAsync<any>(Account, [], 15000);
  const pos = useAsync<any[]>(Positions, [], 6000);
  const bots = useAsync<any[]>(Bots, [], 8000);
  const pnl = useAsync<any>(Pnl, [], 15000);

  const live = !!health?.live;
  const a = acct.data;
  const positions = pos.data || [];
  const day = dayWindow(pnl.data);
  const cash = a?.cash;
  const openCount = pos.data == null ? null : positions.length;
  const blocked = bots.data == null ? null : blockedBotCount(bots.data, health);
  const cap = Number(health?.limits?.maxConcentrationPct);
  const hot = hotConcentration(positions, a?.equity, Number.isFinite(cap) ? cap : health?.limits?.maxConcentrationPct);
  const loss = maxLossPct(health);
  const preview = openRiskPreview(pos.loading ? null : positions, monitors, health?.swingLaw);
  const empty = !pos.loading && positions.length === 0 && monitors != null && preview.total === 0;

  return (
    <div className="home-glass">
      <div className="glance-row">
        <GlassCard title="Today">
          <div className={`glance-figure ${day ? signClass(day.pl) : 'muted'}`}>
            {day ? `${day.pl >= 0 ? '+' : ''}${money(day.pl)}` : '—'}
          </div>
          <div className="glance-meta">
            {day && Number.isFinite(day.pct) ? `${day.pct >= 0 ? '+' : ''}${day.pct.toFixed(2)}% day` : 'Day P/L'}
            {' · '}{openCount == null ? '—' : `${openCount} open`}
            {' · '}Cash {money(cash)}
          </div>
        </GlassCard>

        <GlassCard title="Risk" tone={health?.killSwitch ? 'danger' : hot ? 'warn' : 'default'}>
          <div className={`glance-figure ${health?.killSwitch ? 'health-bad' : ''}`}>
            {health?.killSwitch ? 'Kill on' : 'Kill off'}
          </div>
          <div className="glance-meta">
            {loss == null ? 'Max daily loss —' : `Max daily loss ${loss}%`}
            {hot ? ` · ${hot.symbol} ${hot.pct.toFixed(0)}% of equity` : ''}
          </div>
        </GlassCard>

        <GlassCard title="Issues" tone={blocked ? 'warn' : 'default'}>
          <a className="glance-figure glance-link" href="#/bots?issues=1">
            {blocked == null ? '—' : blocked}
          </a>
          <div className="glance-meta">
            <a href="#/bots?issues=1">{blocked === 1 ? 'blocked bot' : 'blocked bots'}</a>
          </div>
        </GlassCard>
      </div>

      <GlassCard
        title="Open risk"
        right={<a href="#/positions">Positions</a>}
      >
        {pos.loading && !positions.length ? <div className="muted">Loading…</div> : monitors == null && !positions.length ? <div className="muted">Checking exits</div> : empty ? (
          <div className="muted">
            {live ? <div>No open positions.</div> : (
              <>
                <div>{PAPER_POSITIONS_EMPTY}</div>
                <div>{PAPER_NEXT_STEP}</div>
              </>
            )}
          </div>
        ) : (
          <>
            <table className="open-risk">
              <thead>
                <tr>
                  <th>Symbol</th>
                  <th className="num">P/L %</th>
                  <th>Exit</th>
                </tr>
              </thead>
              <tbody>
                {preview.rows.map((r) => (
                  <tr key={r.key}>
                    <td>
                      <div className="open-risk-sym">{r.symbol}</div>
                      {r.detail ? <div className="muted open-risk-detail">{r.detail}</div> : null}
                    </td>
                    <td className="num">
                      {r.pl == null ? <span className="muted">—</span> : <span className={`open-risk-pl ${signClass(r.pl)}`}>{fmtBookPct(r.pl)}</span>}
                    </td>
                    <td><span className={`exit-pulse ${r.pulseTone}`} title={r.pulseTitle}>{r.pulseLabel}</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
            {preview.total > preview.rows.length && (
              <div className="glance-meta"><a href="#/positions">{preview.total - preview.rows.length} more on Positions</a></div>
            )}
          </>
        )}
      </GlassCard>
    </div>
  );
}
