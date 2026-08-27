import { Playbooks, Backtests, ToggleBot } from '../api/client';
import { Card, Badge, useAsync } from '../components/ui';
import { formatOption } from '../lib/options';
import { Icon } from '../components/icons';

function J(v: any, d: any) { if (v == null) return d; if (typeof v === 'object') return v; try { return JSON.parse(v); } catch { return d; } }

const CAT_KIND: Record<string, string> = { swing: 'blue', day: 'amber' };

export default function PlaybooksView() {
  const pb = useAsync<any[]>(Playbooks, [], 0);
  const bt = useAsync<any[]>(Backtests, [], 0);
  const plays = pb.data || [];
  // latest backtest metrics by bot_id
  const metricsByBot: Record<number, any> = {};
  for (const b of bt.data || []) if (b.bot_id && !metricsByBot[b.bot_id]) metricsByBot[b.bot_id] = J(b.metrics, {});

  return (
    <div className="grid" style={{ gap: 14 }}>
      <Card title="2x–10x Options Playbooks — research-backed">
        <div className="muted">
          Data-grounded long-options ideas (calls = bullish, puts = bearish) on your watchlist, built from the
          last 3 months of real price action. <b>High risk, defined risk</b> (max loss = premium). Targets are
          aspirational — the backtest column shows modeled historical performance. Toggle a playbook on to run its
          bot (starts in Observe).
        </div>
      </Card>

      {plays.length === 0 && <Card><div className="muted">No playbooks yet. Run <code>npm run seed:playbooks</code> in /backend.</div></Card>}

      {plays.map((p) => {
        const setup = J(p.setup, {});
        const stats = J(p.stats, {});
        const m = p.bot_id ? metricsByBot[p.bot_id] : null;
        return (
          <Card key={p.id}>
            <div className="row" style={{ justifyContent: 'space-between', alignItems: 'flex-start' }}>
              <div>
                <div className="row" style={{ gap: 8 }}>
                  <b style={{ fontSize: 15 }}>{p.title}</b>
                  <Badge kind={p.option_type === 'call' ? 'green' : 'red'}>{p.option_type?.toUpperCase()}</Badge>
                  <Badge kind={CAT_KIND[p.category] || 'gray'}>{p.category}</Badge>
                  <Badge kind="amber">target {p.target_multiple}</Badge>
                </div>
                <div style={{ marginTop: 6, fontSize: 15 }} className="green icon-btn">
                  <Icon name="orders" size={15} /> {formatOption(setup)}
                </div>
                <div className="muted" style={{ fontSize: 12, marginTop: 2 }}>Trigger: {setup.trigger} · {setup.timeframe}</div>
              </div>
              {m && (
                <div style={{ textAlign: 'right', minWidth: 180 }}>
                  <div className="muted" style={{ fontSize: 11 }}>90d modeled backtest</div>
                  <div className={`stat small ${m.total_return_pct >= 0 ? 'green' : 'red'}`}>{m.total_return_pct}%</div>
                  <div className="muted" style={{ fontSize: 11 }}>
                    {m.num_trades} trades · {m.win_rate}% win · best {m.best_multiple}x · ≥2x: {m.trades_2x}
                  </div>
                </div>
              )}
            </div>

            <div style={{ marginTop: 10 }}>{p.thesis}</div>

            <div className="row" style={{ marginTop: 10, gap: 14, fontSize: 12 }}>
              <span className="muted">3-mo:</span>
              <span className={stats.period_return_pct >= 0 ? 'green' : 'red'}>{stats.period_return_pct}%</span>
              <span className="muted">vol {stats.annualized_vol_pct}%</span>
              <span className="muted">maxGain {stats.max_gain_pct}%</span>
              <span className="muted">maxDD {stats.max_drawdown_pct}%</span>
              <span className="pill">{stats.trend}</span>
              <span className="muted">RSI {stats.rsi14}</span>
              <span className="muted">last ${stats.last}</span>
            </div>

            <div style={{ marginTop: 10, padding: '8px 10px', background: 'rgba(255,92,92,.08)', borderRadius: 8, border: '1px solid rgba(255,92,92,.25)' }}>
              <b className="red">Risk:</b> <span className="muted">{p.risk}</span>
            </div>

            {p.bot_id && (
              <div className="row" style={{ marginTop: 10 }}>
                <button onClick={async () => { await ToggleBot(p.bot_id); bt.reload(); }}>Enable/disable bot</button>
                <a href="#/bots" className="muted" style={{ fontSize: 12 }}>manage on Bots →</a>
              </div>
            )}
          </Card>
        );
      })}
    </div>
  );
}
