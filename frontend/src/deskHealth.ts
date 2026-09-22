/** Sticky desk-health line. No P&L. No em dashes. Health color is not the P&L green. */

import { stuckSell } from './exitPulse';

const FAILURE_LABEL: Record<string, string> = {
  db_down: 'DB down',
  db_read_failed: 'DB read failed',
  not_paper: 'Not paper',
  live_env: 'Not paper',
  alpaca_not_configured: 'Alpaca not set',
  alpaca_unreachable: 'Alpaca down',
};

export type HealthTone = 'ok' | 'warn' | 'bad';

/** CSS variables for the strip. None of these are the P&L green or red tokens. */
export const HEALTH_TONE_COLOR: Record<HealthTone, string> = {
  ok: '--health-ok',
  warn: '--health-warn',
  bad: '--health-bad',
};

export type DeskHealth = {
  ready: string;
  readyOk: boolean;
  tone: HealthTone;
  exits: string;
  jev: string;
  muse: string;
  line: string;
};

export const QUIET_NEXT = 'Rails holding.';
export const STUCK_NEXT = 'Stuck sell · cancel + retry';

export type NextAction = {
  label: string;
  tone: 'quiet' | 'warn' | 'danger';
  href?: string;
};

/** Ready, or the first health failure in its place. Exits stay armed on paper. */
export function deskHealth(health: any, apiDown = false): DeskHealth {
  const unreachable = apiDown || !!health?._unreachable;
  let ready = 'Ready';
  let readyOk = true;
  if (unreachable) {
    ready = 'API down';
    readyOk = false;
  } else if (!health) {
    ready = 'Waiting';
    readyOk = false;
  } else {
    const first = Array.isArray(health.failures) ? health.failures.find((f: unknown) => f != null && String(f) !== '') : null;
    if (first) {
      const key = String(first);
      ready = FAILURE_LABEL[key] || key.replace(/_/g, ' ');
      readyOk = false;
    } else if (health.ready === false) {
      ready = 'Not ready';
      readyOk = false;
    }
  }

  const paper = !unreachable && !!health && health.live !== true && health.env !== 'robinhood_live' && health.paper !== false;
  const exits = unreachable || !health ? 'Exits unknown' : (paper && health.swingLaw ? 'Exits armed' : 'Exits held');

  let jev = 'Jev unknown';
  if (!unreachable && health?.jev) {
    const mode = !health.jev.enabled || health.jev.mode === 'off' ? 'off' : (health.jev.mode === 'active' ? 'active' : 'shadow');
    jev = `Jev ${mode}`;
  }

  let muse = 'Muse unknown';
  if (!unreachable && health?.watch) {
    muse = health.watch.mode === 'observe' ? 'Muse observe' : 'Muse improve';
  }

  let tone: HealthTone = 'ok';
  if (!readyOk) tone = 'bad';
  else if (health?.jev?.degraded || health?.watch?.lastError) tone = 'warn';

  const line = `${ready} · ${exits} · ${jev} · ${muse}`;
  return { ready, readyOk, tone, exits, jev, muse, line };
}

function failureLabel(health: any): string | null {
  const first = Array.isArray(health?.failures) ? health.failures.find((f: unknown) => f != null && String(f) !== '') : null;
  if (first) {
    const key = String(first);
    return FAILURE_LABEL[key] || key.replace(/_/g, ' ');
  }
  if (health?.ready === false) return 'Not ready';
  return null;
}

function openRows(monitors: any[]): any[] {
  return monitors.filter((m) => m && (m.status == null || m.status === 'open'));
}

/**
 * One next action. Fail closed: unknown desk or unknown monitors never say the rails are holding.
 * Day P/L is not an input.
 */
export function nextAction(health: any, apiDown = false, monitors?: any[] | null): NextAction {
  const unreachable = apiDown || !!health?._unreachable || !health;
  if (unreachable) return { label: 'API down', tone: 'danger' };

  if (monitors == null) return { label: 'Checking exits', tone: 'warn' };

  if (openRows(monitors).some((m) => stuckSell(m))) {
    return { label: STUCK_NEXT, tone: 'danger', href: '#/orders' };
  }

  const failed = failureLabel(health);
  if (failed) return { label: failed, tone: 'danger' };

  const law = health.swingLaw;
  const arm = Number(law?.gainLockArmPct);
  const floor = Number(law?.gainLockFloorPct);
  if (!law || !Number.isFinite(arm) || !Number.isFinite(floor)) {
    return { label: 'Arm exits', tone: 'warn' };
  }

  if (health.jev?.degraded) return { label: 'Open Jev last pick', tone: 'warn', href: '#/models/jev' };

  return { label: QUIET_NEXT, tone: 'quiet' };
}

/** Stuck sell forces the strip off the calm tone, even when the day is green. */
export function stripTone(health: any, apiDown = false, monitors?: any[] | null): HealthTone {
  const base = deskHealth(health, apiDown).tone;
  if (monitors == null) return base === 'ok' ? 'warn' : base;
  if (openRows(monitors).some((m) => stuckSell(m))) return 'bad';
  return base;
}
