import { useState } from 'react';
import { Account, Positions, Orders, Approvals, Bots, Monitors, Campaign, Alerts, AlertDismiss, Clock, Pnl, Quickbots, Leaderboard, RunPlay, BotPerformance, TradeDefaults } from '../api/client';
import { sizingLine } from '../components/risksizing';
import { Card, money, num, signClass, statusBadge, useAsync, Badge, FleetBadge, Progress, Sym, Info, Live, posLast } from '../components/ui';
import ConnectionStrip from '../components/Connections';
import { BlockBoard, type BlockItem } from '../components/blocks';
import { DataTable, type Column } from '../components/datatable';
import { BotModeControl, MODE_LEGEND } from '../components/botcontrols';
import { Icon } from '../components/icons';

const PNL_WINDOWS: { key: string; label: string }[] = [
  { key: 'day', label: 'Day' }, { key: 'week', label: 'Week' }, { key: 'month', label: 'Month' },
  { key: 'd90', label: '90 days' }, { key: 'ytd', label: 'YTD' }, { key: 'all', label: '1Y' }, // Alpaca history caps at 1 year (since inception if newer)
];

function J(v: any, d: any) { if (v == null) return d; if (typeof v === 'object') return v; try { return JSON.parse(v); } catch { return d; } }
const pc = (n: any) => `${Number(n) >= 0 ? '+' : ''}${Number(n)}%`;

/** Visual position of an open trade's P/L between its stop-loss (left) and take-profit (right). */
function StopBar({ pl, tp, sl }: { pl: number; tp: number; sl: number }) {
  if (!(tp > 0) && !(sl > 0)) return <span className="muted" style={{ fontSize: 10 }}>—</span>;
  const lo = -(sl > 0 ? sl : tp), hi = tp > 0 ? tp : sl; // bounds
  const frac = Math.max(0, Math.min(1, (pl - lo) / (hi - lo)));
  const col = pl >= 0 ? 'var(--green)' : 'var(--red)';
  return (
    <span title={`P/L ${pl.toFixed(1)}% · stop −${sl}% · target +${tp}%`} style={{ display: 'inline-block', width: 90, height: 8, borderRadius: 4, background: 'linear-gradient(90deg, rgba(255,92,92,.25), rgba(255,255,255,.06) 50%, rgba(46,204,113,.25))', position: 'relative', verticalAlign: 'middle' }}>
      <span style={{ position: 'absolute', left: `calc(${frac * 100}% - 3px)`, top: -1, width: 6, height: 10, borderRadius: 2, background: col }} />
    </span>
  );
}

/** Compact QuickBot row on the dashboard — full mode control + enable, no need to leave. */
function QbRow({ bot, reload }: { bot: any; reload: () => void }) {
  const action = J(bot.action, {});
  const symbols: string[] = J(bot.symbols, []);
  const plays = action.symbol_plays ? Object.values(action.symbol_plays).flat() as any[] : (action.plays || []);
  const calls = plays.filter((p: any) => p.direction === 'call').length;
  const puts = plays.filter((p: any) => p.direction === 'put').length;
  const dtes = [...new Set(plays.map((p: any) => p.dte))].sort((a: any, b: any) => a - b);
  const tuned = !!action.symbol_plays;
  const robust = plays.filter((p: any) => p.robust).length;
  return (
    <div className="row" style={{ justifyContent: 'space-between', padding: '7px 10px', borderRadius: 7, background: 'rgba(255,255,255,.03)', marginBottom: 6, flexWrap: 'wrap', gap: 6 }}>
      <div>
        <a href="#/quickbots"><b>{bot.name}</b></a>{' '}
        <span className="muted" style={{ fontSize: 12 }}>{symbols.map((s, i) => <span key={s}>{i ? ', ' : ''}<Sym>{s}</Sym></span>)}</span>
        <div className="muted" style={{ fontSize: 11 }}>{calls} call / {puts} put plays{tuned ? ' (per-symbol)' : ''} · {robust}/{plays.length} robust · {dtes.join('/')} DTE</div>
      </div>
      <BotModeControl bot={bot} reload={reload} />
    </div>
  );
}

const MODE_NOTE: Record<string, string> = {
  observe: 'Observe — logging only. No real orders are placed.',
  cautious: 'Cautious — every order is staged for your one-click approval.',
  auto: 'Auto — bots auto-execute when rules + the risk engine pass.',
  full_auto: 'Full-Auto — bots execute AND Claude may open new positions within guardrails.',
};

/** Per-row ▶ Run button — turns a backtested play into a live, monitored bot in one click. */
function RunCell({ row, mode, live, onRan }: { row: any; mode: string; live: boolean; onRan: (msg: string) => void }) {
  const [state, setState] = useState<'idle' | 'busy' | 'done' | 'err'>('idle');
  const run = async () => {
    if (mode === 'full_auto' && !confirm(`Run "${row.label}" on ${row.symbol} in FULL-AUTO?\n\nIt will automatically buy this ${row.dir} (${row.dte}DTE) whenever the signal fires${live ? ' — placing REAL-MONEY orders on your live account' : ' (paper account)'}, with its take-profit / stop-loss / trailing-stop monitor enforced. Continue?`)) return;
    setState('busy');
    try {
      await RunPlay({ symbol: row.symbol, key: row.key, dte: row.dte, mode, robust: row.robust, backtest: row.metrics });
      setState('done'); onRan(`Running ${row.symbol} · ${row.label} (${mode === 'full_auto' ? 'full-auto' : 'staged'}) — added to Leaderboard Picks.`);
    } catch (e: any) { setState('err'); onRan('Error: ' + (e?.message || e)); }
  };
  if (state === 'done') return <span className="green icon-btn" style={{ fontSize: 11 }}><Icon name="check" size={14} /> running</span>;
  return <button className="primary" disabled={state === 'busy'} style={{ fontSize: 11, padding: '1px 8px' }} onClick={run} title={`Run ${row.symbol} ${row.label} ${mode === 'full_auto' ? 'full-auto' : 'staged for approval'}`}>{state === 'busy' ? '…' : '▶ Run'}</button>;
}

/** The backtested-strategy leaderboard — sortable/filterable, one-click runnable. */
function LeaderboardBlock({ live }: { live: boolean }) {
  const lead = useAsync<any>(() => Leaderboard(365), [], 0);
  const [mode, setMode] = useState<'cautious' | 'full_auto'>('cautious');
  const [msg, setMsg] = useState('');
  const d = lead.data;
  const rows: any[] = d?.leaderboard || [];
  const cols: Column<any>[] = [
    { key: 'run', label: 'Run', sortable: false, align: 'center', render: (r) => <RunCell row={r} mode={mode} live={live} onRan={setMsg} /> },
    { key: 'symbol', label: 'Symbol', render: (r) => <Sym bold>{r.symbol}</Sym>, sortValue: (r) => r.symbol, filterValue: (r) => `${r.symbol} ${r.label} ${r.dir}` },
    { key: 'label', label: 'Strategy', render: (r) => <span style={{ fontSize: 12 }}>{r.label}</span>, sortValue: (r) => r.label },
    { key: 'dir', label: 'Dir', render: (r) => <span className={r.dir === 'call' ? 'green' : 'red'}>{r.dir}</span>, sortValue: (r) => r.dir, align: 'center' },
    { key: 'dte', label: 'DTE', render: (r) => `${r.dte}d`, sortValue: (r) => r.dte, align: 'center' },
    { key: 'trades', label: 'Trades', sortValue: (r) => r.metrics.num_trades, render: (r) => r.metrics.num_trades, align: 'right' },
    { key: 'win', label: 'Win%', sortValue: (r) => r.metrics.win_rate, render: (r) => `${r.metrics.win_rate}%`, align: 'right' },
    { key: 'total', label: 'Total ($1k)', sortValue: (r) => r.metrics.total_return_pct, render: (r) => <span className={signClass(r.metrics.total_return_pct)}>{pc(r.metrics.total_return_pct)}</span>, align: 'right' },
    { key: 'pf', label: 'PF', sortValue: (r) => r.metrics.profit_factor, render: (r) => <span className={r.metrics.profit_factor >= 1 ? 'green' : 'red'}>{r.metrics.profit_factor}</span>, align: 'right' },
    { key: 'best', label: 'Best×', sortValue: (r) => r.metrics.best_multiple, render: (r) => <span className="green">{r.metrics.best_multiple}×</span>, align: 'right' },
    { key: 'dd', label: <span title="Deepest peak-to-trough dip in cumulative fixed-stake P/L, in % of one $1k stake. Can exceed 100% over a losing streak (each trade is an independent $1k bet), and is independent of the final Total.">Max DD</span>, sortValue: (r) => r.metrics.max_drawdown_pct, render: (r) => <span className="red" title="cumulative fixed-stake P/L drawdown (% of one stake)">{r.metrics.max_drawdown_pct}%</span>, align: 'right' },
    { key: 'robust', label: 'OOS', sortValue: (r) => (r.robust ? 1 : 0), render: (r) => r.robust ? <Badge kind="green">robust</Badge> : <span className="muted" style={{ fontSize: 10 }}>in-sample</span>, align: 'center' },
  ];
  if (lead.loading && !d) return <div className="muted">Running the 1-year backtest scan across all 9 symbols…</div>;
  if (!d) return <div className="muted">{lead.err || 'Leaderboard unavailable.'}</div>;
  return (
    <>
      <div className="muted" style={{ fontSize: 12, marginBottom: 6 }}>
        Every strategy × symbol × DTE backtested over the last year (Black-Scholes priced, spread-costed). <b>{d.counts?.robust}</b> of {d.counts?.tested} are out-of-sample robust. <b>“Total ($1k)”</b> = sum of each trade’s % return betting a fixed $1k per trade (each trade floored at −100%); <b>“Best×”</b> = best single trade; <b>“Max DD”</b> = deepest cumulative dip (can exceed 100% over a losing streak). <b className="green">▶ Run</b> any row to trade it live — added to the <a href="#/quickbots" className="icon-btn"><Icon name="bolt" size={13} /> Leaderboard Picks</a> bot (enabled, TP/SL/trail monitored). <span className="muted">Modeled — ranks strategies, not a promise of fills.</span>
      </div>
      <div className="row" style={{ gap: 10, marginBottom: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <b className="muted" style={{ fontSize: 12 }}>Run mode:</b>
        <div className="mode-seg">
          <button className={mode === 'cautious' ? 'on amber' : ''} onClick={() => setMode('cautious')}>Staged (approve each)</button>
          <button className={mode === 'full_auto' ? 'on red' : ''} onClick={() => setMode('full_auto')}>Full-auto</button>
        </div>
        <span className="muted" style={{ fontSize: 11 }}>{mode === 'full_auto' ? `Full-auto buys automatically when the signal fires${live ? ' — REAL money' : ' (paper)'}.` : 'Staged = every order waits for your one-click approval.'}</span>
      </div>
      {msg && <div style={{ marginBottom: 8, padding: '6px 10px', borderRadius: 7, background: 'rgba(0,208,156,.08)', border: '1px solid rgba(0,208,156,.25)', fontSize: 12 }} className={msg.startsWith('Error') ? 'red' : 'green'}>{msg} <a href="#/quickbots" style={{ marginLeft: 6 }}>manage →</a></div>}
      <DataTable rows={rows} cols={cols} storageKey="leaderboard" initialSort={{ key: 'total', dir: -1 }} pageSize={15} filterPlaceholder="filter symbol/strategy…" rowKey={(r) => `${r.symbol}-${r.key}-${r.dir}-${r.dte}`} />
    </>
  );
}

/** Per-bot LIVE performance — real orders + realized/open P&L from monitors (not modeled). */
function PerformanceBlock() {
  const perf = useAsync<any>(BotPerformance, [], 15000);
  const d = perf.data;
  const rows: any[] = (d?.bots || []).filter((b: any) => b.orders.total > 0 || b.closed_trades > 0 || b.open_positions > 0);
  if (!d) return <div className="muted">Loading…</div>;
  if (rows.length === 0) return <div className="muted">No bot activity on this account yet. Enable a bot (or ▶ Run a leaderboard play) — its real orders, fills and realized/open P&L appear here. <span style={{ fontSize: 11 }}>Modeled backtest stats are separate (in the leaderboard).</span></div>;
  const cols: Column<any>[] = [
    { key: 'name', label: 'Bot', sortValue: (r) => r.name, filterValue: (r) => `${r.name} ${r.mode}`, render: (r) => <span><a href={`#/bots?bot=${r.id}`}><b>{r.name}</b></a> {r.enabled ? <Badge kind="green">ON</Badge> : null}</span> },
    { key: 'mode', label: 'Mode', sortValue: (r) => r.mode, align: 'center', render: (r) => <span className="pill">{String(r.mode).replace('_', '-')}</span> },
    { key: 'orders', label: 'Orders', align: 'right', sortValue: (r) => r.orders.total, render: (r) => <span title={`placed ${r.orders.placed} · filled ${r.orders.filled} · staged ${r.orders.staged} · vetoed ${r.orders.vetoed}`}>{r.orders.total}</span> },
    { key: 'closed', label: 'Closed', align: 'right', sortValue: (r) => r.closed_trades, render: (r) => r.closed_trades },
    { key: 'win', label: 'Win%', align: 'right', sortValue: (r) => r.win_rate, render: (r) => r.closed_trades ? `${r.win_rate}%` : '—' },
    { key: 'realized', label: 'Realized P/L', align: 'right', sortValue: (r) => r.realized_pl_pct, render: (r) => r.closed_trades ? <span className={signClass(r.realized_pl_pct)}>{pc(r.realized_pl_pct)}</span> : <span className="muted">—</span> },
    { key: 'open', label: 'Open', align: 'right', sortValue: (r) => r.open_positions, render: (r) => r.open_positions || '—' },
    { key: 'openpl', label: 'Open P/L', align: 'right', sortValue: (r) => r.open_pl_pct, render: (r) => r.open_positions ? <span className={signClass(r.open_pl_pct)}>{pc(r.open_pl_pct)}</span> : <span className="muted">—</span> },
  ];
  return (
    <>
      <div className="muted" style={{ fontSize: 12, marginBottom: 6 }}>Real activity on your {d.env === 'robinhood_live' ? 'live Robinhood' : 'paper'} account: {d.summary.orders_total} orders, {d.summary.closed_trades} closed trades, {d.summary.open_positions} open. <span title="Measured at the exit-trigger price (the TP/SL/trail level that fired); actual fills include small slippage.">Realized P/L</span> = sum of closed-trade returns; Open P/L = avg unrealized on live monitors.</div>
      <DataTable rows={rows} cols={cols} storageKey="bot-perf" initialSort={{ key: 'realized', dir: -1 }} rowKey={(r) => r.id} filterPlaceholder="filter bots…" />
    </>
  );
}

export default function Dashboard({ health }: { health: any }) {
  const acct = useAsync(Account, [], 6000);
  const pos = useAsync<any[]>(Positions, [], 6000);
  const orders = useAsync<any[]>(() => Orders(20), [], 8000);
  const appr = useAsync<any[]>(Approvals, [], 8000);
  const botList = useAsync<any[]>(Bots, [], 8000);
  const mons = useAsync<any[]>(Monitors, [], 8000);
  const camp = useAsync<any>(Campaign, [], 15000);
  const clock = useAsync<any>(Clock, [], 30000);
  const pnl = useAsync<any>(Pnl, [], 30000);
  const qbots = useAsync<any[]>(Quickbots, [], 12000);
  const [pnlWin, setPnlWin] = useState('day');
  const alerts = useAsync<any[]>(() => Alerts(8), [], 20000);
  const sizing = useAsync<any>(TradeDefaults, [], 30000);
  const activeAlerts = (alerts.data || []).filter((a) => a.status !== 'dismissed');
  const flaggedBotIds = new Set<number>();
  activeAlerts.forEach((a) => { try { (typeof a.bot_ids === 'string' ? JSON.parse(a.bot_ids) : a.bot_ids || []).forEach((id: number) => flaggedBotIds.add(Number(id))); } catch { /* noop */ } });
  const openMons = (mons.data || []).filter((m) => m.status === 'open');
  const a = acct.data;
  const positions = pos.data || [];
  const totalUpl = positions.reduce((s, p) => s + Number(p.unrealized_pl || 0), 0);
  const enabledBots = (botList.data || []).filter((b) => b.enabled);
  const tradingBots = enabledBots.filter((b) => b.mode === 'auto' || b.mode === 'full_auto');
  const stagingBots = enabledBots.filter((b) => b.mode === 'cautious');
  const live = !!health?.live;
  const marketOpen = clock.data ? !!clock.data.is_open : null;
  const nextOpen = clock.data?.next_open
    ? new Date(clock.data.next_open).toLocaleString('en-US', { timeZone: 'America/Los_Angeles', weekday: 'short', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' })
    : null;

  // ── Block content (each becomes an adjustable dashboard block) ──
  const items: BlockItem[] = [];

  if (camp.data?.armed) {
    items.push({ id: 'campaign', title: <><span className="icon-btn"><Icon name="growth" size={15} /> Growth Campaign — armed</span><Info topic="campaign" /></>, right: <a href="#/campaign">open plan →</a>, node: (
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
        <div>
          <span className="stat" style={{ fontSize: 22 }}>{money(camp.data.rh_equity)}</span>
          <span className="muted" style={{ marginLeft: 8 }}>→ {money(camp.data.target_equity)} target</span>
          <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>Starts automatically the moment your Robinhood deposit lands — start equity = the actual deposit.</div>
        </div>
        <Badge kind="amber">waiting for deposit</Badge>
      </div>
    ) });
  } else if (camp.data && camp.data.active !== false) {
    const p = camp.data.progress || {}; const ph = p.current_phase || {};
    items.push({ id: 'campaign', title: <><span className="icon-btn"><Icon name="growth" size={15} /> {camp.data.name}</span><Info topic="campaign" /></>, right: <a href="#/campaign">open plan →</a>, node: (
      <>
        <div className="row" style={{ justifyContent: 'space-between', marginBottom: 6 }}>
          <div><span className="stat" style={{ fontSize: 22 }}>{money(p.equity)}</span><span className="muted" style={{ marginLeft: 8 }}>of {money(camp.data.target_equity)} · {p.multiple_to_go}× to go</span></div>
          {Number(p.equity) > 0 ? <Badge kind={p.pace === 'ahead' ? 'green' : 'amber'}>{p.pace === 'ahead' ? 'ahead of pace' : 'behind pace'}</Badge> : <Badge kind="blue">not funded yet</Badge>}
        </div>
        <Progress value={p.pct_to_goal} kind={p.pace === 'ahead' ? 'green' : 'amber'} />
        <div className="row" style={{ justifyContent: 'space-between', marginTop: 6 }}>
          <span className="muted" style={{ fontSize: 12 }}>Phase {ph.phase} · {ph.name} — {p.days_left} days left</span>
          <span className="muted" style={{ fontSize: 12 }}>{p.pct_to_goal}% of goal</span>
        </div>
        <div style={{ marginTop: 8, padding: '8px 10px', borderRadius: 7, background: 'rgba(255,255,255,.03)', fontSize: 13, lineHeight: 1.45 }}>{String(p.recommendation || '').slice(0, 280)} <a href="#/campaign">more →</a></div>
      </>
    ) });
  }

  if (activeAlerts.length > 0) {
    items.push({ id: 'alerts', title: <><span className="icon-btn"><Icon name="bolt" size={15} /> Signals & alerts</span><Info topic="alerts" /></>, right: <span className="muted" style={{ fontSize: 11 }}>Groq watches news · Kimi escalates</span>, node: (
      <>{activeAlerts.slice(0, 6).map((al) => (
        <div key={al.id} className="alert-row row" style={{ justifyContent: 'space-between', alignItems: 'flex-start' }}>
          <div style={{ flex: 1 }}>
            <div><span className={`alert-dot ${al.level}`} /><b>{al.symbol ? <Sym>{al.symbol}</Sym> : ''}</b> {al.title}<Badge kind={al.level === 'trade' ? 'green' : al.level === 'watch' ? 'amber' : 'blue'}>{al.level}</Badge><span className="pill" style={{ fontSize: 10 }}>{al.source}</span></div>
            {al.body && <div className="muted" style={{ fontSize: 12, marginTop: 2 }}>{al.body}</div>}
          </div>
          <button style={{ fontSize: 11, padding: '1px 7px' }} title="Dismiss" onClick={() => AlertDismiss(al.id).then(alerts.reload)}><Icon name="x" size={14} /></button>
        </div>
      ))}</>
    ) });
  }

  items.push({ id: 'stats', title: 'Account', right: pnl.data?.source !== 'unavailable' && pnl.data?.current ? <span className="muted" style={{ fontSize: 11 }}>live equity {money(pnl.data.current)}</span> : undefined, node: (
    <div className="grid cols-4">
      <Card title="Equity"><div className="stat">{money(a?.equity)}</div></Card>
      <Card title="Buying Power"><div className="stat">{money(a?.buying_power)}</div></Card>
      <Card title="Cash"><div className="stat small">{money(a?.cash)}</div></Card>
      <Card title="Open P/L"><div className={`stat ${signClass(totalUpl)}`}>{money(totalUpl)}</div></Card>
    </div>
  ) });

  items.push({ id: 'pnl', title: <>Account P/L<Info topic="pnl" /></>, right: <span className="mode-seg">{PNL_WINDOWS.map((w) => <button key={w.key} className={pnlWin === w.key ? 'on' : ''} onClick={() => setPnlWin(w.key)}>{w.label}</button>)}</span>, node: (
    pnl.data?.source === 'unavailable' || !pnl.data?.series?.length ? <div className="muted">{pnl.data?.reason || 'No P/L history for this account yet.'}</div> : (() => {
      const win = pnl.data.windows?.[pnlWin];
      const fromDate = win?.from ? new Date(win.from * 1000).toLocaleDateString('en-US', { timeZone: 'America/Los_Angeles', month: 'short', day: 'numeric' }) : null;
      return (
        <>
          <div className="row" style={{ gap: 28, alignItems: 'flex-end', flexWrap: 'wrap' }}>
            <div>
              <div className="muted" style={{ fontSize: 11 }}>{PNL_WINDOWS.find((w) => w.key === pnlWin)?.label} P/L{fromDate ? ` · since ${fromDate}` : ''}{win?.partial ? ' (partial history)' : ''}</div>
              <div className={`stat ${signClass(win?.pl)}`}>{win ? `${win.pl >= 0 ? '+' : ''}${money(win.pl)}` : '—'}</div>
              <div className={signClass(win?.pct)} style={{ fontSize: 13 }}>{win ? pc(win.pct) : ''}</div>
            </div>
            <div className="row" style={{ gap: 18, flexWrap: 'wrap' }}>
              {PNL_WINDOWS.map((w) => { const v = pnl.data.windows?.[w.key]; return (
                <div key={w.key} style={{ cursor: 'pointer', opacity: pnlWin === w.key ? 1 : 0.7 }} onClick={() => setPnlWin(w.key)}>
                  <div className="muted" style={{ fontSize: 10 }}>{w.label}</div>
                  <div className={signClass(v?.pct)} style={{ fontSize: 13, fontWeight: 600 }}>{v ? pc(v.pct) : '—'}</div>
                </div>
              ); })}
            </div>
          </div>
          <div className="muted" style={{ fontSize: 10, marginTop: 6 }}>Real account equity from {pnl.data.source === 'alpaca_history' ? 'Alpaca' : "this account's daily equity snapshots"}. Current {money(pnl.data.current)}. Day change vs prior close.</div>
        </>
      );
    })()
  ) });

  items.push({ id: 'leaderboard', title: <><span className="icon-btn"><Icon name="trophy" size={15} /> Strategy Leaderboard — backtested 2–10× plays, one-click run</span><Info topic="quickbot_bt" /></>, right: <a href="#/quickbots">manage picks →</a>, node: <LeaderboardBlock live={live} /> });

  if ((qbots.data || []).length > 0) {
    items.push({ id: 'quickbots', title: <><span className="icon-btn"><Icon name="bolt" size={15} /> QuickBots</span><Info topic="quickbot" /></>, right: <a href="#/quickbots">open & backtest →</a>, node: (
      <><div className="muted" style={{ fontSize: 12, marginBottom: 8 }}>One-tap short-DTE options bots — calls & puts by signal, DTE-scaled risk, per-symbol tuned. Enable here; tune & backtest on the QuickBots page.</div>{(qbots.data || []).map((b) => <QbRow key={b.id} bot={b} reload={qbots.reload} />)}</>
    ) });
  }

  items.push({ id: 'performance', title: <span className="icon-btn"><Icon name="chart" size={15} /> Bot Performance — live (real fills &amp; P/L)</span>, right: <span className="muted" style={{ fontSize: 11 }}>not modeled</span>, node: <PerformanceBlock /> });

  items.push({ id: 'activebots', title: <>Active Bots — {enabledBots.length} enabled, {tradingBots.length} placing orders <FleetBadge env={health?.env} /> {marketOpen === false && <Badge kind="amber">market closed</Badge>}{marketOpen === true && <Badge kind="green">market open</Badge>}</>, right: <a href="#/bots?open=enabled">manage →</a>, node: (
    <>
      {sizing.data?.trade_defaults && (
        <div className="risk-line" style={{ marginBottom: 8 }}>
          <span className="muted">{sizing.data.trade_defaults.amount_usd == null
            ? 'Sizing: not set (bots use their own lot sizes)'
            : <>Sizing: <b>{sizingLine(sizing.data.trade_defaults)}</b> for every bot that has not set its own.</>}</span>
          <a href="#/settings">change →</a>
        </div>
      )}
      {enabledBots.length === 0 ? <div className="muted">No bots enabled. Enable bots on the Bots page (click a bot, then ON) or from the QuickBots page.</div> : (
      <>
        {marketOpen === false ? (
          <div style={{ marginBottom: 8, padding: '8px 10px', borderRadius: 7, background: 'rgba(245,176,65,.1)', border: '1px solid rgba(245,176,65,.3)' }}>
            <b className="amber icon-btn"><Icon name="backtest" size={14} /> Market closed{nextOpen ? ` — opens ${nextOpen}` : ''}.</b>{' '}
            <span className="muted">These {enabledBots.length} bot(s) are enabled and will be evaluated at the open{tradingBots.length > 0 && <> — {tradingBots.length} can place {live ? 'REAL-MONEY' : 'paper'} orders</>}{stagingBots.length > 0 && <>, {stagingBots.length} will stage for approval</>}. Use “Run now” on the Bots page to test anytime.</span>
          </div>
        ) : tradingBots.length > 0 && (
          <div style={{ marginBottom: 8, padding: '6px 10px', borderRadius: 7, background: live ? 'rgba(255,92,92,.12)' : 'rgba(46,204,113,.1)', border: `1px solid ${live ? 'rgba(255,92,92,.35)' : 'rgba(46,204,113,.3)'}` }}>
            <b className={live ? 'red' : 'green'}>{tradingBots.length} bot(s) will place {live ? 'REAL-MONEY' : 'paper'} orders</b> <span className="muted">when their rules fire during market hours.</span>
          </div>
        )}
        <DataTable
          rows={enabledBots}
          storageKey="dash-activebots"
          filterPlaceholder="filter bots…"
          cols={[
            { key: 'name', label: 'Bot', sortValue: (b) => b.name, filterValue: (b) => `${b.name} ${(J(b.symbols, []) as string[]).join(' ')}`, render: (b) => <span><a href={`#/bots?bot=${b.id}`}><b>{b.name}</b></a> {flaggedBotIds.has(b.id) && <Badge kind="gold"><span className="icon-btn"><Icon name="bolt" size={12} /> signal</span></Badge>}</span> },
            { key: 'symbols', label: 'Symbols', sortable: false, render: (b) => <span className="muted">{(J(b.symbols, []) as string[]).map((s, i) => <span key={s}>{i ? ', ' : ''}<Sym>{s}</Sym></span>)}</span> },
            { key: 'asset_class', label: 'Type', sortValue: (b) => b.asset_class, render: (b) => <span className="pill">{b.asset_class}</span>, align: 'center' },
            { key: 'mode', label: <>Mode &amp; enable<Info text={MODE_LEGEND} /></>, sortable: false, render: (b) => <BotModeControl bot={b} reload={botList.reload} /> },
            { key: 'last_evaluated_at', label: 'Last eval', sortValue: (b) => b.last_evaluated_at || '', render: (b) => <span className="muted" style={{ fontSize: 11 }}>{b.last_evaluated_at ? new Date(b.last_evaluated_at).toLocaleString('en-US', { timeZone: 'America/Los_Angeles' }) : '—'}</span> },
            { key: 'edit', label: '', sortable: false, align: 'right', render: (b) => <a href={`#/bots?bot=${b.id}&edit=1`} title="Edit this bot's full settings">edit</a> },
          ]}
        />
      </>
    )}
    </>
  ) });

  if (openMons.length > 0) {
    items.push({ id: 'monitors', title: <>Live risk monitors ({openMons.length}) — enforcing exits<Info topic="monitors" /></>, node: (
      <>
        <div className="muted" style={{ marginBottom: 6, fontSize: 12 }}>Auto-exits open bot positions on take-profit / stop-loss / trailing-stop (checked every 45s during market hours).</div>
        <DataTable rows={openMons} storageKey="dash-monitors" filter={openMons.length > 6} cols={[
          { key: 'symbol', label: 'Symbol', sortValue: (m) => m.symbol, render: (m) => <span><Sym bold>{m.symbol}</Sym> <span className="pill">{m.asset_class}</span></span> },
          { key: 'entry_price', label: 'Entry', align: 'right', sortValue: (m) => Number(m.entry_price), render: (m) => money(m.entry_price) },
          { key: 'peak_price', label: 'Peak', align: 'right', sortValue: (m) => Number(m.peak_price), render: (m) => money(m.peak_price) },
          { key: 'last_price', label: 'Last', align: 'right', sortValue: (m) => Number(m.last_price), render: (m) => money(m.last_price) },
          { key: 'pl', label: 'P/L', align: 'right', sortValue: (m) => m.entry_price ? (Number(m.last_price) - Number(m.entry_price)) / Number(m.entry_price) : 0, render: (m) => { const pl = m.entry_price ? ((Number(m.last_price) - Number(m.entry_price)) / Number(m.entry_price)) * 100 : 0; return <span className={signClass(pl)}>{pl >= 0 ? '+' : ''}{pl.toFixed(1)}%</span>; } },
          { key: 'zone', label: 'Stop ◄►  Target', sortable: false, align: 'center', render: (m) => { const pl = m.entry_price ? ((Number(m.last_price) - Number(m.entry_price)) / Number(m.entry_price)) * 100 : 0; return <StopBar pl={pl} tp={Number(m.tp_pct)} sl={Number(m.sl_pct)} />; } },
          { key: 'totp', label: '→ TP', align: 'right', sortValue: (m) => { const pl = m.entry_price ? ((Number(m.last_price) - Number(m.entry_price)) / Number(m.entry_price)) * 100 : 0; return Number(m.tp_pct) > 0 ? Number(m.tp_pct) - pl : 999; }, render: (m) => { const pl = m.entry_price ? ((Number(m.last_price) - Number(m.entry_price)) / Number(m.entry_price)) * 100 : 0; return Number(m.tp_pct) > 0 ? <span className="green" title="gain still needed to hit take-profit">{Math.max(0, Number(m.tp_pct) - pl).toFixed(1)}%</span> : <span className="muted">—</span>; } },
          { key: 'tosl', label: '→ SL', align: 'right', sortValue: (m) => { const pl = m.entry_price ? ((Number(m.last_price) - Number(m.entry_price)) / Number(m.entry_price)) * 100 : 0; return Number(m.sl_pct) > 0 ? pl + Number(m.sl_pct) : 999; }, render: (m) => { const pl = m.entry_price ? ((Number(m.last_price) - Number(m.entry_price)) / Number(m.entry_price)) * 100 : 0; const buf = pl + Number(m.sl_pct); return Number(m.sl_pct) > 0 ? <span className={buf < 5 ? 'red' : 'amber'} title="buffer before stop-loss triggers">{buf.toFixed(1)}%</span> : <span className="muted">—</span>; } },
          { key: 'tp', label: 'TP/SL/Trail', sortable: false, render: (m) => <span className="muted" style={{ fontSize: 11 }}>{num(m.tp_pct, 0)}/{num(m.sl_pct, 0)}/{num(m.trail_pct, 0)}%</span> },
        ]} />
      </>
    ) });
  }

  if (appr.data && appr.data.length > 0) {
    items.push({ id: 'approvals', title: `Pending Approvals (${appr.data.length})`, node: <div className="muted">You have staged orders awaiting approval — see the <a href="#/orders">Orders page</a>.</div> });
  }

  items.push({ id: 'positions', title: <>Positions ({positions.length}){positions.some((p) => p.live) ? <> <Live /></> : null}</>, node: (
    positions.length === 0 ? <div className="muted">No positions yet. Connect Robinhood and Sync.</div> : (
      <DataTable rows={positions} storageKey="dash-positions" filter={positions.length > 6} filterPlaceholder="filter positions…" cols={[
        { key: 'symbol', label: 'Symbol', sortValue: (p) => p.symbol, render: (p) => <Sym bold>{p.symbol}</Sym> },
        { key: 'qty', label: 'Qty', align: 'right', sortValue: (p) => Number(p.qty), render: (p) => num(p.qty, 2) },
        { key: 'avg_cost', label: 'Avg', align: 'right', sortValue: (p) => Number(p.avg_cost), render: (p) => money(p.avg_cost) },
        { key: 'current', label: 'Current', align: 'right', sortValue: (p) => Number(posLast(p) ?? 0), render: (p) => { const l = posLast(p); return l != null ? money(l) : '—'; } },
        { key: 'market_value', label: 'Value', align: 'right', sortValue: (p) => Number(p.market_value), render: (p) => money(p.market_value) },
        { key: 'unrealized_pl', label: 'P/L', align: 'right', sortValue: (p) => Number(p.unrealized_pl), render: (p) => <span className={signClass(p.unrealized_pl)}>{money(p.unrealized_pl)}</span> },
      ]} />
    )
  ) });

  items.push({ id: 'orders', title: 'Recent Orders', right: <a href="#/orders">all →</a>, node: (
    (orders.data || []).length === 0 ? <div className="muted">No orders yet.</div> : (
      <DataTable rows={orders.data || []} storageKey="dash-orders" filterPlaceholder="filter orders…" pageSize={10} cols={[
        { key: 'symbol', label: 'Symbol', sortValue: (o) => o.symbol, filterValue: (o) => `${o.symbol} ${o.side} ${o.status} ${o.source}`, render: (o) => <Sym bold>{o.symbol}</Sym> },
        { key: 'side', label: 'Side', sortValue: (o) => o.side, render: (o) => <span className={o.side === 'buy' ? 'green' : 'red'}>{o.side}</span>, align: 'center' },
        { key: 'qty', label: 'Qty', align: 'right', sortValue: (o) => Number(o.qty), render: (o) => num(o.qty, 0) },
        { key: 'price', label: 'Price', align: 'right', sortValue: (o) => Number(o.filled_price ?? o.limit_price ?? 0), render: (o) => { const px = o.filled_price ?? o.limit_price; return px != null ? money(px) : <span className="muted">mkt</span>; } },
        { key: 'status', label: 'Status', sortValue: (o) => o.status, render: (o) => statusBadge(o.status), align: 'center' },
        { key: 'source', label: 'Src', sortValue: (o) => o.source, render: (o) => <span className="pill">{o.source}</span>, align: 'center' },
      ]} />
    )
  ) });

  return (
    <div className="grid" style={{ gap: 14 }}>
      <ConnectionStrip status={health?.connections} />
      <div className="card" style={{ borderColor: health?.killSwitch ? 'var(--red)' : 'var(--border)' }}>
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <div><span className="muted">Mode: </span><b style={{ textTransform: 'capitalize' }}>{health?.mode}</b><Info topic="mode" /> — {MODE_NOTE[health?.mode] || ''}</div>
          {health?.killSwitch && <Badge kind="red">KILL SWITCH ENGAGED</Badge>}
        </div>
      </div>
      <BlockBoard items={items} storageKey="dashboard" />
    </div>
  );
}
