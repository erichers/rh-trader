import { isLeapsLabel } from './risk/dte.js';

/** Minimum closed backtest trades before a bot may auto-trade paper. */
export const PAPER_ARM_MIN_TRADES = 8;

export const MAC_DESK = {
  grokbotRoot: '/Users/eric/Sites/grokbot',
  repo: '/Users/eric/Sites/grokbot/grokbot-rh-trader',
  mamp: 'http://localhost:8888/grokbot/grokbot-rh-trader/',
  api: 'http://127.0.0.1:8011/',
  legacy: '/Users/eric/Sites/rh.tradingbot',
  sibling: '/Users/eric/Sites/grokbot-rhtrader',
  wrongName: '/Users/eric/Sites/grokbot/rh-trader',
  legacyUrl: 'http://localhost:8888/rh.tradingbot/',
} as const;

export type ScanRow = {
  bot_id: number;
  name: string;
  error?: string;
  num_trades?: number;
  total_return_pct?: number;
  account_multiple?: number;
  win_rate?: number;
  modeled?: boolean;
};

export type ArmAction = 'trade' | 'watch' | 'skip';

export type ArmDecision = {
  bot_id: number;
  name: string;
  action: ArmAction;
  reason: string;
};

export type ArmFlags = {
  /** `_ai_boom` / wait-for-signal. Never arm to full auto. */
  signalHold?: boolean;
  /** 0-DTE house skip, including bot 84. */
  zeroDte?: boolean;
};

/**
 * Decide from a backtest scan row whether this bot may auto-trade paper.
 * Observe-only stubs stay watch-only. Modeled-only option results never arm.
 * Wait-for-signal and 0-DTE never arm. Pure: no DB, no orders.
 */
export function decidePaperArm(row: ScanRow, observeOnly: boolean, flags?: ArmFlags): ArmDecision {
  const bot_id = Number(row.bot_id);
  const name = String(row.name || `bot #${bot_id}`);
  if (flags?.signalHold) {
    return { bot_id, name, action: 'skip', reason: 'wait-for-signal / _ai_boom stays off until a person arms it' };
  }
  if (flags?.zeroDte) {
    return { bot_id, name, action: 'skip', reason: '0-DTE house skip — demote candidate, do not auto-promote' };
  }
  if (observeOnly) {
    return { bot_id, name, action: 'watch', reason: 'observe-only stub — signals only, never orders' };
  }
  if (row.error) {
    return { bot_id, name, action: 'skip', reason: `backtest error: ${row.error}` };
  }
  const n = Number(row.num_trades) || 0;
  const ret = Number(row.total_return_pct) || 0;
  if (n < PAPER_ARM_MIN_TRADES) {
    return { bot_id, name, action: 'skip', reason: `only ${n} backtest trades (need ${PAPER_ARM_MIN_TRADES})` };
  }
  if (!(ret > 0)) {
    return { bot_id, name, action: 'skip', reason: `non-positive backtest return ${ret}%` };
  }
  if (row.modeled && !isLeapsLabel(name)) {
    return { bot_id, name, action: 'skip', reason: 'modeled-only option backtest — not real-priced' };
  }
  return {
    bot_id,
    name,
    action: 'trade',
    reason: `backtest ${ret}% over ${n} trades (win ${Number(row.win_rate) || 0}%)`,
  };
}
