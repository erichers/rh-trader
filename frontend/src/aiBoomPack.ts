/** Desk copy for Fox wait-for-signal adds. No em dashes. */

export type BoomPack = {
  id: string;
  name: string;
  kind: 'wait' | 'watch' | 'quickbot' | 'call' | 'leaps';
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
  deferred: string[];
  skipped: string[];
};

export const AI_BOOM_FALLBACK: AiBoomView = {
  note: 'Paper only. Twelve wait-for-signal call bots, default off. Calls, 2-14 DTE. Hard stop and the +1.5% gain-lock still win. Jev exit stays off and still logs. SMCI buys only on a two-sided mid or an ask.',
  prior: 'Fox wait-for-signal adds stay off until you arm them. Deferred, not seeded: DLR, NRG, INTC, CLS, COHR. Not added again: NVDA, AMD, AVGO, MU, META, MSFT, AMZN, TSLA, EOSE, RKLB.',
  deferred: ['DLR', 'NRG', 'INTC', 'CLS', 'COHR'],
  skipped: ['NVDA', 'AMD', 'AVGO', 'MU', 'META', 'MSFT', 'AMZN', 'TSLA', 'EOSE', 'RKLB'],
  packs: [
    {
      id: 'fox-wait',
      name: 'Fox wait for signal',
      kind: 'wait',
      symbols: ['TSM', 'ASML', 'ANET', 'VRT', 'ARM', 'MRVL', 'CEG', 'VST', 'EQIX', 'ORCL', 'ETN', 'SMCI'],
      badges: ['paper', 'off', 'wait for signal', 'calls 2-14 DTE', 'Jev exit off', 'SMCI strict price'],
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
    deferred: Array.isArray(row.deferred) ? row.deferred.map((s) => String(s).toUpperCase()) : AI_BOOM_FALLBACK.deferred,
    skipped: Array.isArray(row.skipped) ? row.skipped.map((s) => String(s).toUpperCase()) : AI_BOOM_FALLBACK.skipped,
    packs: row.packs.map((p) => ({
      id: String(p.id || p.name),
      name: String(p.name || 'pack'),
      kind: p.kind || 'wait',
      symbols: Array.isArray(p.symbols) ? p.symbols.map((s) => String(s).toUpperCase()) : [],
      badges: Array.isArray(p.badges) ? p.badges.map((b) => String(b)) : ['Jev exit off'],
      fullAuto: false,
      jevExit: false,
      enabled: false,
    })),
  };
}

export function badgeKind(badge: string): string {
  if (/strict price|unverified|not full auto/i.test(badge)) return 'amber';
  if (/wait for signal|watch only|no orders/i.test(badge)) return 'blue';
  if (/Jev exit off|^off$/i.test(badge)) return 'gray';
  return 'gray';
}
