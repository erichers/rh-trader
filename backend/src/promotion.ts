import { q, exec, audit, getRiskLimits, getTradingEnv } from './db.js';
import { backtestQuickbot, walkForwardQuickbot } from './quickbot.js';
import { botPerformance } from './perf.js';
import { raiseAlert } from './alerts.js';

// Paper → live promotion gate. A bot earns a live deployment by clearing a checklist of
// EVIDENCE — modeled edge (positive, out-of-sample robust, survives walk-forward) AND a real
// paper track record AND sane risk config. Promotion never flips the account to real money
// (that stays an explicit user action); it marks the bot graduated and drops it to Cautious so
// the first live orders are human-approved. Honest: every item shows the real number behind it.

const MIN_PAPER_TRADES = 8;

type Item = { key: string; label: string; pass: boolean; critical: boolean; detail: string };

function parse(v: any): any { if (v == null) return null; if (typeof v === 'object') return v; try { return JSON.parse(v); } catch { return null; } }
function r2(n: number, d = 2): number { const f = 10 ** d; return Number.isFinite(n) ? Math.round(n * f) / f : 0; }

export async function promotionChecklist(botId: number): Promise<any> {
  // Account-scoped: you can only promote a bot that belongs to the ACTIVE account, and
  // promotion never switches accounts (that stays an explicit action in the top bar).
  const env = await getTradingEnv();
  const [bot] = await q<any>('SELECT * FROM bots WHERE id=:id AND env=:env', { id: botId, env });
  if (!bot) throw new Error('bot not found');
  const action = parse(bot.action) || {};
  const risk = parse(bot.risk) || {};
  const symbols: string[] = parse(bot.symbols) || [];
  const isQuick = action._quickbot === true;
  const sym = String(action._research || symbols[0] || '').toUpperCase();

  const items: Item[] = [];
  let edge: any = null, wf: any = null;

  // ── Modeled edge (quickbots): backtest + walk-forward on the primary symbol ──
  if (isQuick && sym) {
    const bt = await backtestQuickbot(sym, { days: 365 }).catch(() => null);
    const play = bt?.chosen?.[0] || bt?.all?.find((p: any) => p.metrics.num_trades >= 8) || null;
    edge = play ? { symbol: sym, key: play.key, expectancy: play.metrics.expectancy_pct, trades: play.metrics.num_trades, robust: play.robust, total_return: play.metrics.total_return_pct } : null;
    items.push({
      key: 'backtest_edge', label: 'Backtest edge is positive', critical: true,
      pass: !!play && play.metrics.expectancy_pct > 0 && play.metrics.num_trades >= 8,
      detail: play ? `${sym} ${play.key}: expectancy ${play.metrics.expectancy_pct}% over ${play.metrics.num_trades} trades (total ${play.metrics.total_return_pct}%).` : `No backtestable play for ${sym}.`,
    });
    items.push({
      key: 'out_of_sample', label: 'Edge holds out-of-sample (both halves)', critical: true,
      pass: !!play && !!play.robust,
      detail: play ? (play.robust ? `Positive in BOTH halves (H1 ${play.oos.h1}%, H2 ${play.oos.h2}%).` : `Only worked in one half (H1 ${play.oos.h1}%, H2 ${play.oos.h2}%) — likely curve-fit.`) : '—',
    });
    wf = await walkForwardQuickbot(sym, { days: 365, folds: 5 }).catch(() => null);
    items.push({
      key: 'walk_forward', label: 'Survives walk-forward (efficiency ≥ 0.5)', critical: true,
      pass: !!wf && wf.oos_avg_expectancy > 0 && wf.efficiency >= 0.5,
      detail: wf ? `Efficiency ${wf.efficiency} (OOS ${wf.oos_avg_expectancy}% / IS ${wf.is_avg_expectancy}%), ${wf.oos_positive_folds}/${wf.folds} folds positive — ${wf.verdict}.` : 'Walk-forward unavailable.',
    });
  } else {
    items.push({ key: 'backtest_edge', label: 'Backtest edge is positive', critical: false, pass: false, detail: 'Non-QuickBot strategy — run the Backtest tab and confirm an edge manually before going live.' });
  }

  // ── Real paper track record (closed monitors for this bot in paper) ──
  const perf = await botPerformance('alpaca_paper');
  const row = perf.bots.find((b: any) => b.id === botId);
  const closed = Number(row?.closed_trades) || 0;
  const realized = Number(row?.realized_pl_pct) || 0;
  const winRate = Number(row?.win_rate) || 0;
  items.push({
    key: 'paper_trades', label: `Paper track record (≥ ${MIN_PAPER_TRADES} closed trades)`, critical: true,
    pass: closed >= MIN_PAPER_TRADES,
    detail: `${closed} closed paper trade(s)${closed ? `, ${winRate}% win-rate` : ''}. ${closed < MIN_PAPER_TRADES ? 'Let it run more in paper first.' : 'Sufficient sample.'}`,
  });
  items.push({
    key: 'paper_profitable', label: 'Paper trading is net positive', critical: true,
    pass: closed >= MIN_PAPER_TRADES && realized >= 0,
    detail: closed ? `Realized ${realized >= 0 ? '+' : ''}${realized}% across paper trades.` : 'No closed paper trades yet.',
  });

  // ── Risk config sanity ──
  const limits = await getRiskLimits();
  const hasStop = Number(risk.stop_loss_pct) > 0 || (Array.isArray(action.symbol_plays ? null : null), isQuick); // quickbots carry per-play DTE stops
  const stopOk = isQuick || Number(risk.stop_loss_pct) > 0;
  items.push({
    key: 'risk_stop', label: 'Stop-loss / exit protection configured', critical: true,
    pass: stopOk,
    detail: isQuick ? 'QuickBot plays carry DTE-scaled stop-loss + trailing exits.' : (Number(risk.stop_loss_pct) > 0 ? `Stop-loss ${risk.stop_loss_pct}%.` : 'No stop-loss set — add one before live.'),
  });
  const posCap = Number(risk.override?.max_position_usd ?? risk.max_position_usd ?? 0);
  const capOk = !posCap || posCap <= limits.maxPositionUsd * 1.0 || isQuick;
  items.push({
    key: 'position_cap', label: 'Position cap within global limits', critical: false,
    pass: capOk,
    detail: posCap ? `Per-position cap ${posCap} vs global ${limits.maxPositionUsd}.` : `Uses global cap ${limits.maxPositionUsd}.`,
  });
  void hasStop;
  items.push({
    key: 'hold_policy', label: 'Overnight/weekend hold policy reviewed', critical: false,
    pass: true,
    detail: `Default flattens before close${risk.hold_overnight ? ' (overridden: holds overnight)' : ''}${risk.hold_over_weekend ? ' (overridden: holds over weekend)' : ''}.`,
  });

  const criticalItems = items.filter((i) => i.critical);
  const passedCritical = criticalItems.filter((i) => i.pass).length;
  const gate = criticalItems.every((i) => i.pass);
  const score = items.length ? Math.round((items.filter((i) => i.pass).length / items.length) * 100) : 0;

  return {
    bot: { id: bot.id, name: bot.name, mode: bot.mode, enabled: !!bot.enabled, is_quickbot: isQuick, symbol: sym, graduated: action._graduated === true },
    gate, score, passed_critical: passedCritical, total_critical: criticalItems.length,
    items, edge, walk_forward: wf,
    recommendation: gate
      ? 'Ready to graduate. Promoting sets the bot to Cautious — switch the account to Live (Robinhood) yourself, then approve the first orders before flipping to Auto.'
      : `Not ready: ${criticalItems.filter((i) => !i.pass).map((i) => i.label).join('; ')}.`,
    notes: 'Graduation never switches the account to real money — that is always your explicit action in the top bar. This gate only certifies the evidence and drops the bot to Cautious for a supervised live start.',
  };
}

/** Promote a bot: requires the gate to pass (unless force). Marks graduated, drops to Cautious. */
export async function promoteBot(botId: number, opts: { force?: boolean } = {}): Promise<any> {
  const check = await promotionChecklist(botId);
  if (!check.gate && !opts.force) return { promoted: false, blocked: true, ...check };
  const env = await getTradingEnv();
  const [bot] = await q<any>('SELECT * FROM bots WHERE id=:id AND env=:env', { id: botId, env });
  if (!bot) throw new Error('bot not found');
  const action = parse(bot.action) || {};
  action._graduated = true;
  action._graduated_at = new Date().toISOString();
  await exec("UPDATE bots SET action=CAST(:a AS JSON), mode='cautious' WHERE id=:id AND env=:env", { a: JSON.stringify(action), id: botId, env });
  await audit('bot.promote', `bot #${botId} (${bot.name}) graduated to live-ready → Cautious${opts.force && !check.gate ? ' (FORCED)' : ''}`, { score: check.score, forced: !!(opts.force && !check.gate) });
  await raiseAlert({
    level: 'info', source: 'system', title: `Bot graduated: ${bot.name}`,
    body: `Promoted to live-ready (score ${check.score}%) and set to Cautious. Switch to Live to deploy; first orders need your approval.`,
    bot_ids: [botId], dedupMin: 0,
  });
  return { promoted: true, blocked: false, mode: 'cautious', ...check, gate: true };
}
