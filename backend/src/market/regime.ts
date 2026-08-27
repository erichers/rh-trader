// ─────────────────────────────────────────────────────────────────────────────
// Current market regime (H2 2026) — used to score whether a strategy/bot FITS the
// environment we're trading into now vs. the backtest window it looked good in.
// Sourced from the deep macro brief: hawkish Warsh Fed (oil-driven inflation),
// AI/memory supercycle intact, midterm-year Sept/Oct drawdown → post-election Q4
// rally. This filters out backtest winners that only worked in a different regime.
// ─────────────────────────────────────────────────────────────────────────────

export const REGIME = {
  asOf: '2026-06-21',
  label: 'Hawkish Fed · AI/memory supercycle · midterm Q3 drawdown → Q4 rally',
  // Sectors/themes with a tailwind right now → bullish longs fit.
  tailwind: ['MU', 'NVDA', 'AMD', 'AVGO', 'SMCI', 'TSM', 'CEG', 'VST', 'GEV', 'VRT', 'ETN', 'OKLO', 'CCJ', 'XLE', 'XOM', 'CVX', 'OXY', 'ITA', 'LMT', 'RTX', 'LLY', 'META', 'TSLA', 'GOOGL', 'MSFT'],
  // Names/structures that are HEDGES in this regime (long puts on the broad index).
  hedge: ['SPY', 'QQQ', 'IWM', 'DIA'],
  // Rate-sensitive / long-duration story stocks that fight a hawkish Fed.
  headwind: ['ARKK', 'TLT', 'XLU', 'XLRE'],
};

export type SeasonalFit = { score: number; badge: 'seasonal-fit' | 'regime-neutral' | 'regime-caution'; reasons: string[] };

/** Score how well a bot fits the CURRENT regime (0–100) + a badge + reasons. */
export function seasonalFit(bot: { symbols?: any; asset_class?: string; action?: any; rules?: any }): SeasonalFit {
  const symbols: string[] = (Array.isArray(bot.symbols) ? bot.symbols : tryArr(bot.symbols)).map((s) => String(s).toUpperCase());
  const action = typeof bot.action === 'string' ? tryObj(bot.action) : (bot.action || {});
  const isOption = (bot.asset_class || 'equity') === 'option';
  const optType = action.option_type as 'call' | 'put' | undefined;
  const reasons: string[] = [];
  let score = 50;

  const hitTail = symbols.filter((s) => REGIME.tailwind.includes(s));
  const hitHead = symbols.filter((s) => REGIME.headwind.includes(s));
  const isIndex = symbols.some((s) => REGIME.hedge.includes(s));

  if (hitTail.length) {
    // Bullish exposure (long calls / equity) to tailwind names = strong fit.
    if (!isOption || optType !== 'put') { score += 28; reasons.push(`Bullish exposure to tailwind names (${hitTail.join(', ')}) — AI/memory/power/energy/defense supercycle`); }
    else { score -= 10; reasons.push(`Puts on a tailwind name (${hitTail.join(', ')}) fights the uptrend`); }
  }
  if (hitHead.length) { score -= 22; reasons.push(`Exposure to rate-sensitive headwind names (${hitHead.join(', ')}) vs a hawkish Fed`); }

  // Index PUTS are valuable hedges into the Sept/Oct midterm drawdown window.
  if (isIndex && isOption && optType === 'put') { score += 22; reasons.push('Index put hedge fits the midterm Q3 drawdown window'); }
  // Naked long index calls held into Q3 weakness = caution (better after the Oct bottom).
  if (isIndex && isOption && optType === 'call') { score -= 8; reasons.push('Long index calls face Q3 seasonal weakness before the Q4 rally'); }

  // Mean-reversion dip buyers fit a choppy, high-dispersion tape.
  const rules = typeof bot.rules === 'string' ? tryObj(bot.rules) : (bot.rules || {});
  if (rules.rsi_below) { score += 8; reasons.push('Dip-buying fits a choppy, headline-driven tape'); }

  score = Math.max(0, Math.min(100, Math.round(score)));
  const badge: SeasonalFit['badge'] = score >= 68 ? 'seasonal-fit' : score <= 40 ? 'regime-caution' : 'regime-neutral';
  if (!reasons.length) reasons.push('Neutral vs the current regime');
  return { score, badge, reasons };
}

function tryArr(v: any): any[] { if (Array.isArray(v)) return v; try { const x = JSON.parse(v); return Array.isArray(x) ? x : []; } catch { return []; } }
function tryObj(v: any): any { if (v && typeof v === 'object') return v; try { return JSON.parse(v) || {}; } catch { return {}; } }
