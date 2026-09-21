import { config, isLiveEnv, type Mode, type TradingEnv } from '../config.js';
import { ping, getGlobalMode, getKillSwitch, getTradingEnv, getRiskLimits } from '../db.js';
import { alpacaConfigured, probeAlpacaPaper, type AlpacaProbe } from '../brokers/alpaca.js';
import { RISK_LAW } from './law.js';
import { SWING_LAW } from './exitpolicy.js';
import { museWatchStatus, type MuseWatchLamp } from '../muse/watch.js';
import { jevHealth, type JevHealth } from './jevBudget.js';

export type HealthFailure =
  | 'db_down'
  | 'db_read_failed'
  | 'not_paper'
  | 'live_env'
  | 'alpaca_not_configured'
  | 'alpaca_unreachable';

export type PaperHealth = {
  ok: boolean;
  ready: boolean;
  db: boolean;
  env: TradingEnv | string;
  live: boolean;
  paper: boolean;
  mode: Mode | string;
  killSwitch: boolean;
  listen: string;
  pid: number;
  uptime_s: number;
  alpaca: AlpacaProbe;
  failures: HealthFailure[];
  riskLaw: { maxTradeUsd: number; maxDailyDrawdownPct: number };
  swingLaw: typeof SWING_LAW;
  limits: { maxPositionUsd: number; maxConcentrationPct: number; maxDailyLossPct: number; maxOrdersPerDay: number } | null;
  watch?: MuseWatchLamp;
  jev?: JevHealth;
};

/** Pure verdict used by /api/health and tests. Never throws. */
export function healthVerdict(input: {
  db: boolean;
  env: string;
  live: boolean;
  alpaca: { ok: boolean; configured: boolean };
}): { paper: boolean; ready: boolean; failures: HealthFailure[] } {
  const failures: HealthFailure[] = [];
  const paper = !input.live && input.env === 'alpaca_paper';
  if (!input.db) failures.push('db_down');
  if (input.live || input.env === 'robinhood_live') failures.push('live_env');
  if (!paper) failures.push('not_paper');
  if (!input.alpaca.configured) failures.push('alpaca_not_configured');
  else if (!input.alpaca.ok) failures.push('alpaca_unreachable');
  const ready = input.db && paper && !input.live && input.alpaca.ok;
  return { paper, ready, failures };
}

/**
 * Assemble a health payload that never throws. If MySQL or Alpaca is down the
 * process still answers so the desk banner / health.sh can show the real cause
 * instead of a generic 500 / "API not listening".
 */
export async function collectPaperHealth(): Promise<PaperHealth> {
  const listen = `127.0.0.1:${config.server.port}`;
  const base = {
    listen,
    pid: process.pid,
    uptime_s: Math.round(process.uptime()),
    riskLaw: { maxTradeUsd: RISK_LAW.maxTradeUsd, maxDailyDrawdownPct: RISK_LAW.maxDailyDrawdownPct },
    swingLaw: SWING_LAW,
  };

  let db = false;
  try { db = await ping(); } catch { db = false; }

  let env: TradingEnv | string = config.trading.defaultEnv;
  let live = isLiveEnv(env as TradingEnv);
  let mode: Mode | string = config.trading.defaultMode;
  let killSwitch = config.trading.killSwitch;
  let limits: PaperHealth['limits'] = null;
  const extraFailures: HealthFailure[] = [];

  if (db) {
    try {
      env = await getTradingEnv();
      live = isLiveEnv(env as TradingEnv);
      mode = await getGlobalMode();
      killSwitch = await getKillSwitch();
      limits = await getRiskLimits();
    } catch {
      db = false;
      extraFailures.push('db_read_failed');
    }
  }

  let alpaca: AlpacaProbe;
  try {
    alpaca = await probeAlpacaPaper(2500);
  } catch (e: any) {
    alpaca = {
      ok: false,
      configured: alpacaConfigured(),
      error: e?.message || 'alpaca probe failed',
    };
  }

  const verdict = healthVerdict({ db, env: String(env), live, alpaca });
  const failures = [...new Set([...extraFailures, ...verdict.failures])];

  let watch: MuseWatchLamp | undefined;
  try { watch = museWatchStatus(); } catch { /* lamp stays omitted */ }
  let jev: JevHealth | undefined;
  try { jev = await jevHealth(); } catch { /* optional */ }

  return {
    ok: db, // process answered; db is the minimum "API can persist"
    ready: verdict.ready,
    db,
    env,
    live,
    paper: verdict.paper,
    mode,
    killSwitch,
    alpaca,
    failures,
    limits,
    watch,
    jev,
    ...base,
  };
}
