/** Sticky desk-health line. No P&L. No em dashes. */

const FAILURE_LABEL: Record<string, string> = {
  db_down: 'DB down',
  db_read_failed: 'DB read failed',
  not_paper: 'Not paper',
  live_env: 'Not paper',
  alpaca_not_configured: 'Alpaca not set',
  alpaca_unreachable: 'Alpaca down',
};

export type DeskHealth = {
  ready: string;
  readyOk: boolean;
  exits: string;
  jev: string;
  muse: string;
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

  return { ready, readyOk, exits, jev, muse };
}
