/** Honest exit pulse for an open long. Swing law wins over a looser bot stop. */

export type ExitPulse = {
  label: string;
  tone: 'red' | 'amber' | 'green' | 'muted';
  title: string;
};

type SwingLaw = {
  hardStopPct?: number;
  gainLockArmPct?: number;
  gainLockFloorPct?: number;
  trailPct?: number;
};

function n(v: unknown, fallback: number): number {
  const x = Number(v);
  return Number.isFinite(x) ? x : fallback;
}

export function stuckSell(row: { pending_exit_order_id?: unknown; reason?: unknown } | null | undefined): boolean {
  if (!row) return false;
  if (row.pending_exit_order_id != null && String(row.pending_exit_order_id) !== '' && Number(row.pending_exit_order_id) !== 0) return true;
  return /EXIT STUCK|EXIT FAILED|stuck sell/i.test(String(row.reason || ''));
}

/** Pulse from health.swingLaw. A stuck working sell is always red. */
export function exitPulse(row: any, law?: SwingLaw | null): ExitPulse {
  if (stuckSell(row)) {
    return {
      label: 'Stuck sell',
      tone: 'red',
      title: 'A sell is still working. The position stays open until it fills.',
    };
  }
  const slLaw = n(law?.hardStopPct, 10);
  const arm = n(law?.gainLockArmPct, 10);
  const floor = n(law?.gainLockFloorPct, 1.5);
  const botSl = Number(row?.sl_pct);
  const sl = botSl > 0 ? Math.min(botSl, slLaw) : slLaw;
  const botTrail = Number(row?.trail_pct);
  const trail = botTrail > 0 ? Math.min(botTrail, n(law?.trailPct, 10)) : 0;
  const entry = Number(row?.entry_price);
  const last = Number(row?.last_price);
  const peakPx = Number(row?.peak_price);
  if (!(entry > 0) || !Number.isFinite(last)) {
    return { label: 'No mark', tone: 'muted', title: 'No entry or last price, so the swing-law pulse is blank.' };
  }
  const pct = (v: number) => Math.round(v * 100) / 100;
  const fav = pct(((last - entry) / entry) * 100);
  const peak = pct(((Math.max(Number.isFinite(peakPx) ? peakPx : 0, last, entry) - entry) / entry) * 100);
  const title = `Swing law hard stop ${sl}%. Gain-lock floor +${floor}% after +${arm}%. Now ${fav.toFixed(1)}%, peak ${peak.toFixed(1)}%.`;
  if (fav <= -sl) return { label: 'Hard stop', tone: 'red', title };
  if (peak >= arm && fav <= floor) return { label: 'Gain-lock', tone: 'red', title };
  if (trail > 0 && peak >= arm && fav <= peak - trail) return { label: 'Trail', tone: 'amber', title };
  if (peak >= arm) return { label: 'Lock armed', tone: 'green', title };
  return { label: 'Holding', tone: 'muted', title };
}
