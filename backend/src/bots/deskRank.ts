/**
 * Rank a paper bot from closed monitors and the latest backtest row.
 * Demote chronic losers, tighten size on stop-heavy bots, promote winners.
 * Does not change the hard stop or the gain-lock. Does not turn Jev exit on.
 * Unverified liquidity never reaches full auto.
 */

export const RANK_MIN_CLOSES = 5;
export const RANK_STOP_MIN = 4;
export const RANK_LOSER_WIN = 0.45;
export const RANK_WINNER_WIN = 0.5;
export const RANK_STOP_RATE = 0.5;
export const RANK_TIGHTEN = 0.6;
export const RANK_FLOOR_USD = 400;
export const RANK_BACKTEST_MIN = 8;

export type RankAction = 'demote' | 'tighten' | 'promote' | 'hold';

export type RankClose = {
  pnl_pct?: number | null;
  entry_price?: number | null;
  exit_price?: number | null;
  last_price?: number | null;
  reason?: string | null;
};

export type RankBacktest = {
  num_trades?: number | null;
  total_return_pct?: number | null;
  modeled?: boolean | null;
  error?: string | null;
};

export type RankBot = {
  id?: number | null;
  name?: string | null;
  mode?: string | null;
  enabled?: number | boolean | null;
  asset_class?: string | null;
  action?: any;
  risk?: any;
  observeOnly?: boolean;
  leaps?: boolean;
};

export type RankDecision = {
  bot_id: number | null;
  name: string;
  action: RankAction;
  reason: string;
  mode?: 'observe' | 'cautious' | 'full_auto';
  enabled?: 0 | 1;
  maxPositionUsd?: number;
  /** Always false. Exit scope is a human switch. */
  touchJevExit: false;
};

function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

export function closePnl(row: RankClose): number {
  if (row.pnl_pct != null && Number.isFinite(Number(row.pnl_pct))) return Number(row.pnl_pct);
  const entry = num(row.entry_price);
  const exit = num(row.exit_price) > 0 ? num(row.exit_price) : num(row.last_price);
  if (!(entry > 0) || !Number.isFinite(exit)) return 0;
  return ((exit - entry) / entry) * 100;
}

export function isStopReason(reason: string | null | undefined): boolean {
  return /stop[- ]?loss|hard stop/i.test(String(reason || ''));
}

function parseObj(v: any): Record<string, any> {
  if (v == null) return {};
  if (typeof v === 'object') return v;
  try { return JSON.parse(v) || {}; } catch { return {}; }
}

function liquidity(action: Record<string, any>): string {
  return String(action._liquidity || '');
}

function puts(action: Record<string, any>, name: string): boolean {
  const ot = String(action.option_type || '').toLowerCase();
  if (ot === 'put') return true;
  return /\bput\b/i.test(name) && !/call/i.test(name);
}

function currentUsd(risk: Record<string, any>): number {
  const top = num(risk.max_position_usd);
  const over = num(risk.override && typeof risk.override === 'object' ? risk.override.max_position_usd : 0);
  return Math.max(top, over);
}

export function rankDeskBot(bot: RankBot, closes: RankClose[], backtest?: RankBacktest | null): RankDecision {
  const name = String(bot.name || `bot #${bot.id ?? '?'}`);
  const id = bot.id != null ? Number(bot.id) : null;
  const action = parseObj(bot.action);
  const risk = parseObj(bot.risk);
  const base = { bot_id: id, name, touchJevExit: false as const };
  const stamped = risk._desk_rank && typeof risk._desk_rank === 'object' ? String(risk._desk_rank.action || '') : '';

  if (bot.observeOnly || action._observe_only === true) {
    return { ...base, action: 'hold', reason: 'watch stub stays observe' };
  }
  if (stamped === 'demote') {
    return { ...base, action: 'hold', reason: 'already demoted from closed trades' };
  }

  const pnls = closes.map(closePnl);
  const n = pnls.length;
  const wins = pnls.filter((p) => p > 0).length;
  const avg = n ? pnls.reduce((s, p) => s + p, 0) / n : 0;
  const winRate = n ? wins / n : 0;
  const stops = closes.filter((c) => isStopReason(c.reason)).length;
  const stopRate = n ? stops / n : 0;
  const loser = n >= RANK_MIN_CLOSES && avg < 0 && winRate < RANK_LOSER_WIN;
  const stopHeavy = n >= RANK_STOP_MIN && stopRate >= RANK_STOP_RATE;

  if (loser) {
    return {
      ...base,
      action: 'demote',
      mode: 'observe',
      enabled: 0,
      reason: `${n} closes, avg ${avg.toFixed(1)}%, win ${(winRate * 100).toFixed(0)}%. Demote to observe. Hard stop unchanged.`,
    };
  }

  if (stopHeavy) {
    if (stamped === 'tighten') {
      return { ...base, action: 'hold', reason: 'size already tightened after stop-heavy closes' };
    }
    const cur = currentUsd(risk) || 1500;
    const next = Math.max(RANK_FLOOR_USD, Math.round(cur * RANK_TIGHTEN));
    if (cur > 0 && cur <= next) {
      return { ...base, action: 'hold', reason: 'stop-heavy, size already at the floor' };
    }
    return {
      ...base,
      action: 'tighten',
      maxPositionUsd: next,
      reason: `${stops} of ${n} closes were stops. Size ${cur} to ${next}. Hard stop stays -10%.`,
    };
  }

  const bt = backtest || null;
  const btN = num(bt?.num_trades);
  const btRet = num(bt?.total_return_pct);
  const modeledBlock = !!bt?.modeled && !bot.leaps;
  const unverified = liquidity(action) === 'unverified' || risk._liquidity === 'unverified';
  const winner = n >= RANK_MIN_CLOSES && avg > 0 && winRate >= RANK_WINNER_WIN
    && !bt?.error && btN >= RANK_BACKTEST_MIN && btRet > 0 && !modeledBlock;

  if (winner && puts(action, name)) {
    return { ...base, action: 'hold', reason: 'puts stay off the calls-only book' };
  }
  if (winner && unverified) {
    return { ...base, action: 'hold', reason: 'winning sample, liquidity still unverified, so not full auto' };
  }
  if (winner) {
    return {
      ...base,
      action: 'promote',
      mode: 'full_auto',
      enabled: 1,
      reason: `${n} closes avg ${avg.toFixed(1)}% and backtest ${btRet}% over ${btN}. Promote on paper. Jev exit stays off.`,
    };
  }

  if (n < RANK_MIN_CLOSES) {
    return { ...base, action: 'hold', reason: `${n} closed trades. Need ${RANK_MIN_CLOSES} before a rank change.` };
  }
  return { ...base, action: 'hold', reason: 'sample is mixed. Leave mode and size.' };
}

/** Merge a decision into risk. Never sets jev.exit. Returns null when risk is unchanged. */
export function riskAfterRank(riskIn: any, decision: RankDecision): Record<string, any> | null {
  if (decision.action === 'hold') return null;
  const risk = { ...parseObj(riskIn) };
  const jev = risk.jev && typeof risk.jev === 'object' ? { ...risk.jev } : { entry: false, exit: false };
  if (jev.exit == null) jev.exit = false;
  risk.jev = jev;
  risk._desk_rank = {
    action: decision.action,
    at: new Date().toISOString(),
    reason: decision.reason,
  };
  if (decision.action === 'demote') {
    risk._full_auto_ok = false;
  }
  if (decision.action === 'promote') {
    risk._full_auto_ok = true;
  }
  if (decision.action === 'tighten' && decision.maxPositionUsd != null) {
    risk.max_position_usd = decision.maxPositionUsd;
    if (risk.override && typeof risk.override === 'object') {
      risk.override = { ...risk.override, max_position_usd: decision.maxPositionUsd };
    }
  }
  if (risk.jev.exit === true && parseObj(riskIn).jev?.exit !== true) {
    risk.jev = { ...risk.jev, exit: false };
  }
  return risk;
}

export function actionAfterRank(actionIn: any, decision: RankDecision): Record<string, any> | null {
  if (decision.action !== 'promote' && decision.action !== 'demote') return null;
  const action = { ...parseObj(actionIn) };
  action._full_auto_ok = decision.action === 'promote';
  return action;
}
