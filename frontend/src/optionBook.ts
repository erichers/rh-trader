/** Shared option-book math for Positions and the dashboard monitors. */

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

export type OccParts = {
  root: string;
  human: string;
};

/** "September 30, 2026, $500 Call" from an OCC symbol. Null when it is not an OCC. */
export function parseOcc(raw: unknown): OccParts | null {
  const s = String(raw || '').trim().toUpperCase();
  const m = s.match(/^([A-Z]{1,6})(\d{2})(\d{2})(\d{2})([CP])(\d{8})$/);
  if (!m) return null;
  const month = Number(m[3]);
  const day = Number(m[4]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const strike = Number(m[6]) / 1000;
  if (!Number.isFinite(strike)) return null;
  const strikeTxt = `$${strike.toFixed(3).replace(/\.?0+$/, '')}`;
  const type = m[5] === 'C' ? 'Call' : 'Put';
  return {
    root: m[1],
    human: `${MONTHS[month - 1]} ${day}, ${2000 + Number(m[2])}, ${strikeTxt} ${type}`,
  };
}

export function humanOcc(raw: unknown): string {
  return parseOcc(raw)?.human || '';
}

export function optionMultiplier(assetClass: unknown, occ?: unknown): number {
  const ac = String(assetClass || '').toLowerCase();
  if (ac === 'option' || parseOcc(occ)) return 100;
  return 1;
}

export function bookPlPct(entry: unknown, last: unknown): number | null {
  const e = Number(entry);
  const l = Number(last);
  if (!(e > 0) || !Number.isFinite(l)) return null;
  return ((l - e) / e) * 100;
}

export function bookPeakPct(entry: unknown, peak: unknown): number | null {
  const e = Number(entry);
  const p = Number(peak);
  if (!(e > 0) || !(p > 0)) return null;
  return ((p - e) / e) * 100;
}

/** Premium times contracts. Options use the ×100 contract multiplier. */
export function bookSizeUsd(qty: unknown, price: unknown, assetClass: unknown, occ?: unknown): number | null {
  const q = Number(qty);
  const px = Number(price);
  if (!Number.isFinite(q) || !Number.isFinite(px)) return null;
  return q * px * optionMultiplier(assetClass, occ);
}

export function fmtBookPct(n: number | null): string {
  if (n == null || !Number.isFinite(n)) return '';
  return `${n >= 0 ? '+' : ''}${n.toFixed(1)}%`;
}
