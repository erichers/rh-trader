/**
 * Standing law 2026-09-21: this desk is OPTIONS ONLY.
 * Never seed, convert, or park leftover equity/ETF bots — DELETE or refuse.
 * Mac already deleted #3 MACD, #4 Golden Cross, #5 Bollinger, #6 Donchian,
 * #7 Trend, #8 Momentum Day, #9 ORB, #10 Intraday MR, #17 AI Conviction,
 * #81 Equity Snapback. Autofix must not bring them back as shares or calls.
 */

export const OPTIONS_ONLY_ASSET_CLASS = 'option';

/** Leftover equity rows Eric deleted on the Mac desk. Seed must never recreate them. */
export const DELETED_EQUITY_BOT_KEYS = [
  'macd-momentum',
  'golden-cross',
  'bollinger-reversion',
  'donchian-breakout',
  'trend-follow',
  'momentum-day',
  'opening-breakout',
  'mean-reversion-day',
  'ai-conviction-swing',
  'equity-snapback',
] as const;

export const DELETED_EQUITY_BOT_NAMES = [
  'MACD Momentum',
  'Golden Cross (position)',
  'Bollinger Reversion',
  'Donchian Breakout',
  'Trend Follower',
  'Momentum Day Trade',
  'Opening Range Breakout',
  'Intraday Mean Reversion',
  'AI Conviction Swing',
  'Equity Snapback',
] as const;

export const EQUITY_REFUSED_REASON = 'equity_refused — options-only desk (do not convert/park)';

export function isEquityAssetClass(ac: unknown): boolean {
  const s = String(ac || '').trim().toLowerCase();
  return s === 'equity' || s === 'etf' || s === 'us_equity' || s === 'stock' || s === 'shares';
}

export function isDeletedLeftoverEquity(bot: { name?: string | null; key?: string | null; action?: any } | null | undefined): boolean {
  const name = String(bot?.name || '').trim().toLowerCase();
  if (name && (DELETED_EQUITY_BOT_NAMES as readonly string[]).some((n) => n.toLowerCase() === name)) return true;
  const key = String(
    bot?.key
    || bot?.action?._strategy
    || bot?.action?.strategy
    || bot?.action?._play?.key
    || '',
  ).trim().toLowerCase();
  return !!(key && (DELETED_EQUITY_BOT_KEYS as readonly string[]).includes(key as typeof DELETED_EQUITY_BOT_KEYS[number]));
}

/** Env allowlist: drop equity/etf even if .env still lists them. Empty → option. */
export function optionOnlyAllowlist(raw: string | string[] | undefined | null): string[] {
  const parts = Array.isArray(raw)
    ? raw
    : String(raw || OPTIONS_ONLY_ASSET_CLASS).split(',');
  const allowed = parts.map((s) => String(s).trim().toLowerCase()).filter((s) => s === OPTIONS_ONLY_ASSET_CLASS);
  return allowed.length ? allowed : [OPTIONS_ONLY_ASSET_CLASS];
}

/** Refuse create/update/seed of an equity or leftover-equity row. Null = allowed. */
export function refuseEquityBot(body: {
  asset_class?: unknown;
  action?: any;
  name?: string | null;
  key?: string | null;
} | null | undefined): string | null {
  if (!body) return null;
  if (isEquityAssetClass(body.asset_class)) return EQUITY_REFUSED_REASON;
  if (isDeletedLeftoverEquity(body)) return EQUITY_REFUSED_REASON;
  return null;
}

/** New buys: equity/ETF tickets are refused (sells of leftover shares may still flatten). */
export function refuseEquityBuy(draft: { asset_class?: unknown; side?: unknown } | null | undefined): string | null {
  if (!draft) return null;
  if (String(draft.side || 'buy').toLowerCase() !== 'buy') return null;
  return isEquityAssetClass(draft.asset_class) ? EQUITY_REFUSED_REASON : null;
}
