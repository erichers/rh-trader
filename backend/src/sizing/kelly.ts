import { q, getTradingEnv, getRiskLimits } from '../db.js';
import { backtestQuickbot, type PlayResult } from '../quickbot.js';
import type { TradingEnv } from '../config.js';

// Position sizing wired off REAL backtest expectancy. Translates a play's win-rate / payoff
// profile into a Kelly-optimal capital fraction, then recommends a CONSERVATIVE fractional-Kelly
// dollar size — bounded by the live account equity and the risk engine's max-position cap.
// Honest by construction: it sizes off the same modeled backtest the leaderboard shows, and it
// leads with QUARTER-Kelly because Kelly on a small, fat-tailed options sample is wildly
// over-aggressive at full size.

function r2(n: number, d = 2): number { const f = 10 ** d; return Number.isFinite(n) ? Math.round(n * f) / f : 0; }

async function liveEquity(env: TradingEnv): Promise<number> {
  const a = (await q<any>('SELECT equity FROM accounts WHERE env=:env ORDER BY updated_at DESC LIMIT 1', { env }))[0];
  return Number(a?.equity) || 0;
}

/** Size one play. Provide symbol (+ optional key/dte to target a specific play, else the
 *  best chosen play for that symbol). `equity` overrides the live account value. */
export async function kellySizing(opts: { symbol: string; key?: string; dte?: number; equity?: number; days?: number }): Promise<any> {
  const env = await getTradingEnv();
  const symbol = String(opts.symbol || '').toUpperCase();
  if (!symbol) throw new Error('symbol required');
  const equity = Number(opts.equity) > 0 ? Number(opts.equity) : await liveEquity(env);
  const bt = await backtestQuickbot(symbol, { days: opts.days ?? 365 });
  // Target a specific play if asked; else the top chosen play; else the top of `all`.
  let play: PlayResult | undefined;
  if (opts.key) play = bt.all.find((p) => p.key === opts.key && (!opts.dte || p.dte === Number(opts.dte)));
  play = play || bt.chosen[0] || bt.all.find((p) => p.metrics.num_trades >= 8) || bt.all[0];
  if (!play) throw new Error(`no backtestable play for ${symbol}`);
  const m = play.metrics;
  const limits = await getRiskLimits();
  const capCfg = Number(play.risk?.max_position_usd) || limits.maxPositionUsd;

  const full = m.kelly_fraction;          // fraction of capital to deploy as premium per trade
  const half = r2(full / 2, 3), quarter = r2(full / 4, 3);
  const ladder = [
    { name: 'Full Kelly', frac: r2(full, 3), deploy_usd: r2(full * equity), note: 'theoretical max growth — too aggressive in practice (ruin risk on variance/estimation error).' },
    { name: 'Half Kelly', frac: half, deploy_usd: r2(half * equity), note: 'aggressive but common; ~75% of Kelly growth at far lower drawdown.' },
    { name: 'Quarter Kelly', frac: quarter, deploy_usd: r2(quarter * equity), note: 'recommended for short-DTE options — robust to a noisy/overfit edge.' },
  ];
  // Quarter-Kelly is the headline recommendation, bounded by the risk engine's per-position cap.
  const recDeploy = Math.min(quarter * equity, capCfg);
  const capped = quarter * equity > capCfg && capCfg > 0;
  // Vol-target alternative: cap the loss-at-stop to a fixed % of equity. A stop at sl% means the
  // most you lose on the deployed premium is sl% of it, so deploy = (riskBudget) / (sl/100).
  const sl = Number(play.risk?.sl) || 0;
  const riskTargetPct = 1.5; // risk ~1.5% of equity per trade at the stop
  const volTargetDeploy = sl > 0 ? r2((riskTargetPct / 100 * equity) / (sl / 100)) : null;

  return {
    symbol, env, equity: r2(equity),
    play: { key: play.key, label: play.label, dir: play.dir, dte: play.dte, robust: play.robust },
    edge: {
      win_rate: m.win_rate, payoff_ratio: m.payoff_ratio, expectancy_pct: m.expectancy_pct,
      avg_win_pct: m.avg_win_pct, avg_loss_pct: m.avg_loss_pct, num_trades: m.num_trades, profit_factor: m.profit_factor,
    },
    kelly: { full: r2(full, 3), half, quarter },
    ladder,
    recommended: {
      method: 'quarter-Kelly (capped by risk engine)',
      deploy_usd: r2(recDeploy), pct_equity: equity > 0 ? r2((recDeploy / equity) * 100, 2) : null,
      capped_by_max_position: capped, max_position_usd: capCfg,
      risk_at_stop_usd: sl > 0 ? r2(recDeploy * (sl / 100)) : null,
    },
    vol_target: volTargetDeploy != null ? { risk_per_trade_pct: riskTargetPct, stop_loss_pct: sl, deploy_usd: volTargetDeploy } : null,
    has_edge: full > 0 && m.expectancy_pct > 0,
    notes: full <= 0
      ? 'No positive Kelly edge in the backtest (expectancy ≤ 0) — the math says DO NOT take this play at size. Paper-trade or skip.'
      : 'Kelly fractions come from the modeled backtest (win-rate × payoff). Lead with quarter-Kelly; the engine still clamps every order to your max-position cap. Re-tune after fresh data — a stale edge over-sizes.',
  };
}
