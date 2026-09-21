/**
 * Index QuickBot is a SPY + QQQ basket. Focus mode and hand edits can leave
 * NVDA (or anything else) on symbols / symbol_plays. Clamp back. Do not disable.
 */

export const INDEX_QUICKBOT_SYMBOLS = ['SPY', 'QQQ'] as const;

export function isIndexQuickbotName(name: unknown): boolean {
  return /index quickbot/i.test(String(name || ''));
}

export function parseSymbolList(raw: unknown): string[] {
  let v = raw;
  if (typeof v === 'string') {
    const s = v.trim();
    if (!s) return [];
    try { v = JSON.parse(s); } catch { v = s.split(/[,\s]+/); }
  }
  if (!Array.isArray(v)) return [];
  return [...new Set(v.map((s) => String(s || '').trim().toUpperCase()).filter(Boolean))];
}

function clone<T>(v: T): T {
  return v == null ? v : JSON.parse(JSON.stringify(v));
}

/** Null when this is not the index basket, or it is already only SPY and QQQ. */
export function clampIndexQuickbotUniverse(bot: {
  name?: string | null;
  symbols?: unknown;
  action?: any;
}): { symbols: string[]; action: any; removed: string[] } | null {
  if (!isIndexQuickbotName(bot?.name)) return null;
  const symbols = parseSymbolList(bot.symbols);
  const action = clone(bot.action && typeof bot.action === 'object' ? bot.action : {}) || {};
  const plays = action.symbol_plays && typeof action.symbol_plays === 'object' ? action.symbol_plays : null;
  const extraPlays = plays
    ? Object.keys(plays).map((k) => k.toUpperCase()).filter((k) => !INDEX_QUICKBOT_SYMBOLS.includes(k as 'SPY' | 'QQQ'))
    : [];
  const drifted = symbols.filter((s) => !INDEX_QUICKBOT_SYMBOLS.includes(s as 'SPY' | 'QQQ'));
  const missing = INDEX_QUICKBOT_SYMBOLS.filter((s) => !symbols.includes(s));
  if (!drifted.length && !missing.length && !extraPlays.length) return null;
  if (plays) {
    const next: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(plays)) {
      const sym = k.toUpperCase();
      if (INDEX_QUICKBOT_SYMBOLS.includes(sym as 'SPY' | 'QQQ')) next[sym] = v;
    }
    action.symbol_plays = next;
  }
  return {
    symbols: [...INDEX_QUICKBOT_SYMBOLS],
    action,
    removed: [...new Set([...drifted, ...extraPlays])],
  };
}

/**
 * Focus rewrites every bot onto one ticker in memory. Index QuickBot keeps
 * SPY and QQQ so it cannot open (or Jev-gate) NVDA.
 */
export function evalSymbols(
  bot: { name?: string | null; symbols?: unknown },
  focus?: { enabled?: boolean; symbol?: string | null } | null,
): unknown {
  if (focus?.enabled && focus.symbol && !isIndexQuickbotName(bot?.name)) {
    return JSON.stringify([String(focus.symbol).trim().toUpperCase()]);
  }
  return bot.symbols;
}
