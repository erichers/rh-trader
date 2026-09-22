/** Home glance math. Exit honesty sorts ahead of a green day. */

import { blockedBotCount } from './botIssues';
import { exitPulse } from './exitPulse';
import { bookPlPct, parseOcc } from './optionBook';

export { blockedBotCount };

export function maxLossPct(health: any): number | null {
  const n = Number(health?.limits?.maxDailyLossPct ?? health?.riskLaw?.maxDailyDrawdownPct);
  return Number.isFinite(n) ? n : null;
}

function rootOf(row: any): string {
  const occ = row?.occ_symbol || (String(row?.asset_class || '').toLowerCase() === 'option' ? row?.symbol : '');
  return parseOcc(occ)?.root || String(row?.symbol || '').toUpperCase();
}

/** Hottest name at or over the concentration cap. Null when nothing is hot. */
export function hotConcentration(
  positions: any[] | null | undefined,
  equity: unknown,
  maxPct: unknown,
): { symbol: string; pct: number } | null {
  const eq = Number(equity);
  const cap = Number(maxPct);
  if (!(eq > 0) || !(cap > 0)) return null;
  const by = new Map<string, number>();
  for (const p of positions || []) {
    const key = rootOf(p);
    if (!key) continue;
    const mv = Math.abs(Number(p?.market_value) || 0);
    by.set(key, (by.get(key) || 0) + mv);
  }
  let hot: { symbol: string; pct: number } | null = null;
  for (const [symbol, mv] of by) {
    const pct = (mv / eq) * 100;
    if (pct >= cap && (!hot || pct > hot.pct)) hot = { symbol, pct };
  }
  return hot;
}

const PULSE_RANK: Record<string, number> = {
  'Stuck sell': 0,
  'Hard stop': 0,
  'Gain-lock': 0,
  Trail: 1,
  'No mark': 2,
  'Exits unknown': 2,
};

export type OpenRiskPreview = {
  key: string;
  symbol: string;
  detail: string;
  pl: number | null;
  pulseLabel: string;
  pulseTone: 'red' | 'amber' | 'green' | 'muted';
  pulseTitle: string;
};

function monitorFor(p: any, openMons: any[]): any | undefined {
  return openMons.find((m) => m.occ_symbol && (p.occ_symbol === m.occ_symbol || p.symbol === m.occ_symbol))
    || openMons.find((m) => m.symbol && p.symbol === m.symbol);
}

/**
 * Short open-risk list. Stuck and stop rows sort first.
 * monitors null means the exit watch has not loaded: do not invent a calm pulse.
 */
export function openRiskPreview(
  positions: any[] | null | undefined,
  monitors: any[] | null | undefined,
  law: any,
  limit = 6,
): { rows: OpenRiskPreview[]; total: number } {
  const openMons = (monitors || []).filter((m) => m && m.status === 'open');
  const book = (positions || []).length
    ? (positions || []).map((p) => ({ p, mon: monitors == null ? null : monitorFor(p, openMons) }))
    : openMons.map((m) => ({ p: m, mon: m }));

  const rows = book.map(({ p, mon }, i) => {
    const occ = p.occ_symbol || mon?.occ_symbol || (String(p.asset_class || '').toLowerCase() === 'option' ? p.symbol : '');
    const parsed = parseOcc(occ);
    const entry = mon?.entry_price ?? p.entry_price ?? p.avg_cost;
    const last = p.last_price ?? mon?.last_price;
    const pl = bookPlPct(entry, last);
    const pulse = monitors == null
      ? { label: 'Exits unknown', tone: 'muted' as const, title: 'Exit watch has not loaded.' }
      : mon
        ? exitPulse(mon, law)
        : { label: 'No exit watch', tone: 'muted' as const, title: 'No open monitor on this position.' };
    return {
      key: String(p.id || occ || p.symbol || i),
      symbol: parsed?.root || String(p.symbol || ''),
      detail: parsed?.human || '',
      pl,
      pulseLabel: pulse.label,
      pulseTone: pulse.tone,
      pulseTitle: pulse.title,
    };
  });

  rows.sort((a, b) => (PULSE_RANK[a.pulseLabel] ?? 3) - (PULSE_RANK[b.pulseLabel] ?? 3) || (a.pl ?? 0) - (b.pl ?? 0));
  return { rows: rows.slice(0, limit), total: rows.length };
}
