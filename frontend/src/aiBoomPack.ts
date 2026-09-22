/** Desk copy for the AI boom watch. No em dashes. */

export type BoomPack = {
  id: string;
  name: string;
  kind: 'watch' | 'quickbot' | 'call' | 'leaps';
  symbols: string[];
  badges: string[];
  fullAuto: false;
  jevExit: false;
  enabled: false;
};

export type AiBoomView = {
  note: string;
  prior: string;
  packs: BoomPack[];
};

export const AI_BOOM_FALLBACK: AiBoomView = {
  note: 'Paper only. Calls, or the LEAPS bot as already designed. Hard stop and the +1.5% gain-lock still win. Jev exit stays off and still logs.',
  prior: 'Mag-7 fleet does not include AVGO. Power and datacenter names were absent from the quickbot universe. New packs stay off full auto until closed trades support them.',
  packs: [
    {
      id: 'watch',
      name: 'AI Boom Watch',
      kind: 'watch',
      symbols: ['AVGO', 'TSM', 'ASML', 'ARM', 'SMCI', 'MU', 'AMD', 'NVDA', 'MRVL', 'ANET', 'CRDO', 'VST', 'CEG', 'NRG', 'VRT', 'GEV', 'EQIX', 'DLR', 'CCI'],
      badges: ['paper', 'watch only', 'no orders', 'Jev exit off'],
      fullAuto: false,
      jevExit: false,
      enabled: false,
    },
    {
      id: 'chips',
      name: 'AI Chips Call Pack',
      kind: 'quickbot',
      symbols: ['AVGO', 'TSM', 'ASML', 'ARM', 'SMCI', 'MU', 'AMD', 'NVDA', 'MRVL', 'ANET'],
      badges: ['paper', 'calls 2-14 DTE', 'not full auto', 'Jev exit off', 'AVGO included'],
      fullAuto: false,
      jevExit: false,
      enabled: false,
    },
    {
      id: 'power',
      name: 'AI Power Call Pack',
      kind: 'quickbot',
      symbols: ['VST', 'CEG', 'NRG', 'VRT'],
      badges: ['paper', 'calls 2-14 DTE', 'not full auto', 'Jev exit off'],
      fullAuto: false,
      jevExit: false,
      enabled: false,
    },
    {
      id: 'datacenter',
      name: 'AI Datacenter Call Pack',
      kind: 'quickbot',
      symbols: ['EQIX', 'DLR', 'CCI'],
      badges: ['paper', 'calls 2-14 DTE', 'liquidity unverified', 'not full auto', 'Jev exit off'],
      fullAuto: false,
      jevExit: false,
      enabled: false,
    },
    {
      id: 'avgo-call',
      name: 'AVGO Broadcom Call',
      kind: 'call',
      symbols: ['AVGO'],
      badges: ['paper', 'calls 2-14 DTE', 'not full auto', 'Jev exit off'],
      fullAuto: false,
      jevExit: false,
      enabled: false,
    },
    {
      id: 'avgo-leaps',
      name: 'AVGO LEAPS Call',
      kind: 'leaps',
      symbols: ['AVGO'],
      badges: ['paper', 'LEAPS', 'not full auto', 'Jev exit off'],
      fullAuto: false,
      jevExit: false,
      enabled: false,
    },
  ],
};

export function aiBoomView(raw: unknown): AiBoomView {
  const row = raw && typeof raw === 'object' ? raw as Partial<AiBoomView> : null;
  if (!row || !Array.isArray(row.packs) || !row.packs.length) return AI_BOOM_FALLBACK;
  return {
    note: String(row.note || AI_BOOM_FALLBACK.note),
    prior: String(row.prior || AI_BOOM_FALLBACK.prior),
    packs: row.packs.map((p) => ({
      id: String(p.id || p.name),
      name: String(p.name || 'pack'),
      kind: p.kind || 'watch',
      symbols: Array.isArray(p.symbols) ? p.symbols.map((s) => String(s).toUpperCase()) : [],
      badges: Array.isArray(p.badges) ? p.badges.map((b) => String(b)) : ['Jev exit off'],
      fullAuto: false,
      jevExit: false,
      enabled: false,
    })),
  };
}

export function badgeKind(badge: string): string {
  if (/unverified|not full auto/i.test(badge)) return 'amber';
  if (/watch only|no orders/i.test(badge)) return 'blue';
  if (/Jev exit off/i.test(badge)) return 'gray';
  if (/LEAPS|AVGO/i.test(badge)) return 'green';
  return 'gray';
}
