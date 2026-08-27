import { q, exec } from '../db.js';
import type { Mode, TradingEnv } from '../config.js';

export type StrategyTemplate = {
  key: string;
  name: string;
  category: 'swing' | 'day' | 'options-calls' | 'options-puts' | 'ai';
  asset_class: 'equity' | 'etf' | 'option';
  timeframe: '1d' | '1h' | '15m' | '5m' | '1m';
  description: string;
  education: string;
  rules: Record<string, any>;
  ai_gate: { enabled: boolean; min_conviction?: number };
  action: {
    side: 'buy' | 'sell';
    qty: number;
    order_type: 'market' | 'limit';
    option_type?: 'call' | 'put';
    strike_target?: 'itm' | 'atm' | 'otm';
    expiration?: 'weekly' | 'monthly';
  };
  default_symbols: string[];
};

const SWING = (o: Partial<StrategyTemplate> & Pick<StrategyTemplate, 'key' | 'name' | 'description' | 'rules'>): StrategyTemplate => ({
  category: 'swing',
  asset_class: 'equity',
  timeframe: '1d',
  education: '',
  ai_gate: { enabled: false },
  action: { side: 'buy', qty: 1, order_type: 'market' },
  default_symbols: ['AAPL', 'MSFT', 'NVDA', 'SPY', 'QQQ'],
  ...o,
});

export const STRATEGY_LIBRARY: StrategyTemplate[] = [
  // ── Swing (equity, long) ──────────────────────────────────────────────────
  SWING({
    key: 'rsi-bounce',
    name: 'RSI Bounce',
    description: 'Buy oversold pullbacks in an uptrend.',
    education: 'RSI(14) under 32 while price holds above its 20-day average — a dip in an uptrend, not a breakdown.',
    rules: { rsi_below: 32, price_above_sma20: true, min_matches: 1 },
  }),
  SWING({
    key: 'ema-crossover',
    name: 'EMA 9/21 Crossover',
    description: 'Momentum entry when the fast EMA crosses above the slow EMA.',
    education: 'EMA9 over EMA21 signals short-term momentum turning up.',
    rules: { ema_cross: true },
  }),
  SWING({
    key: 'macd-momentum',
    name: 'MACD Momentum',
    description: 'Trend continuation when MACD turns positive above SMA20.',
    education: 'MACD histogram > 0 with price above its 20-day average = momentum with trend.',
    rules: { macd_positive: true, price_above_sma20: true, require_all: true },
  }),
  SWING({
    key: 'golden-cross',
    name: 'Golden Cross (position)',
    description: 'Long-term trend entry when SMA50 crosses above SMA200.',
    education: 'Classic long-horizon bull signal; slow but high conviction.',
    rules: { golden_cross: true },
  }),
  SWING({
    key: 'bollinger-reversion',
    name: 'Bollinger Reversion',
    description: 'Buy when price closes below the lower Bollinger band.',
    education: 'Mean reversion: a stretch below the lower band often snaps back to the mid band.',
    rules: { bollinger_lower: true },
  }),
  SWING({
    key: 'donchian-breakout',
    name: 'Donchian Breakout',
    description: 'Buy 20-day highs (trend breakout).',
    education: 'Buying new 20-day highs rides momentum; pairs well with a trailing exit.',
    rules: { breakout_high: true },
  }),
  SWING({
    key: 'trend-follow',
    name: 'Trend Follower',
    description: 'Price above SMA20 with positive MACD.',
    education: 'Stay long while trend + momentum agree; exit when either fails.',
    rules: { price_above_sma20: true, macd_positive: true, require_all: true },
  }),

  // ── Day trades (equity, intraday) ─────────────────────────────────────────
  {
    ...SWING({ key: 'momentum-day', name: 'Momentum Day Trade', description: 'Intraday momentum burst.', rules: { change_above: 1.5, macd_positive: true, min_matches: 1 } }),
    category: 'day',
    timeframe: '5m',
    education: '5-minute momentum: +1.5% with rising MACD. Manage exits same-session (no overnight hold).',
    default_symbols: ['SPY', 'QQQ', 'TSLA', 'NVDA', 'AMD'],
  },
  {
    ...SWING({ key: 'opening-breakout', name: 'Opening Range Breakout', description: 'Break of the early-session range.', rules: { breakout_high: true } }),
    category: 'day',
    timeframe: '5m',
    education: 'Buy a clean break of the opening range high on volume; day-trade exit.',
    default_symbols: ['SPY', 'QQQ', 'AAPL', 'TSLA'],
  },
  {
    ...SWING({ key: 'mean-reversion-day', name: 'Intraday Mean Reversion', description: 'Fade deep intraday oversold dips.', rules: { rsi_below: 25 } }),
    category: 'day',
    timeframe: '5m',
    education: 'Sharp 5-min RSI flush under 25 often bounces; small size, quick exit.',
    default_symbols: ['SPY', 'QQQ', 'IWM'],
  },

  // ── Options: long CALLS (bullish, never written/short) ────────────────────
  {
    ...SWING({ key: 'long-call-momentum', name: 'Long Call — Momentum', description: 'Buy ATM weekly calls on bullish momentum.', rules: { ema_cross: true, macd_positive: true, min_matches: 1 } }),
    category: 'options-calls',
    asset_class: 'option',
    education: 'Buy-to-open ATM calls when momentum turns up. Defined risk = premium paid.',
    action: { side: 'buy', qty: 1, order_type: 'market', option_type: 'call', strike_target: 'atm', expiration: 'weekly' },
    default_symbols: ['AAPL', 'NVDA', 'TSLA', 'SPY', 'QQQ'],
  },
  {
    ...SWING({ key: 'long-call-breakout', name: 'Long Call — Breakout', description: 'Buy OTM calls on 20-day breakouts.', rules: { breakout_high: true } }),
    category: 'options-calls',
    asset_class: 'option',
    education: 'OTM calls give leverage to a breakout; size small (lottery-style risk).',
    action: { side: 'buy', qty: 1, order_type: 'market', option_type: 'call', strike_target: 'otm', expiration: 'monthly' },
    default_symbols: ['NVDA', 'TSLA', 'AMD', 'META'],
  },
  {
    ...SWING({ key: 'leaps-call', name: 'Long Call — Trend (dated)', description: 'Buy longer-dated ITM calls on golden cross.', rules: { golden_cross: true } }),
    category: 'options-calls',
    asset_class: 'option',
    education: 'ITM, longer-dated calls behave like leveraged shares with less theta decay.',
    action: { side: 'buy', qty: 1, order_type: 'market', option_type: 'call', strike_target: 'itm', expiration: 'monthly' },
    default_symbols: ['AAPL', 'MSFT', 'SPY'],
  },

  // ── Options: long PUTS (bearish via long puts — no shorting) ───────────────
  {
    ...SWING({ key: 'long-put-breakdown', name: 'Long Put — Breakdown', description: 'Buy puts on 20-day breakdowns / death cross.', rules: { breakdown_low: true, death_cross: true, min_matches: 1 } }),
    category: 'options-puts',
    asset_class: 'option',
    education: 'Buy-to-open puts for bearish exposure without shorting. Defined risk = premium.',
    action: { side: 'buy', qty: 1, order_type: 'market', option_type: 'put', strike_target: 'atm', expiration: 'weekly' },
    default_symbols: ['SPY', 'QQQ', 'TSLA', 'NVDA'],
  },
  {
    ...SWING({ key: 'long-put-hedge', name: 'Long Put — Hedge / Overbought', description: 'Buy protective puts when overbought.', rules: { bollinger_upper: true, rsi_above: 70, min_matches: 1 } }),
    category: 'options-puts',
    asset_class: 'option',
    education: 'Protective/contrarian puts when price is stretched above the upper band and RSI > 70.',
    action: { side: 'buy', qty: 1, order_type: 'market', option_type: 'put', strike_target: 'otm', expiration: 'monthly' },
    default_symbols: ['SPY', 'QQQ', 'AAPL'],
  },
  {
    ...SWING({ key: 'long-put-momentum', name: 'Long Put — Down Momentum', description: 'Buy puts on sharp down days.', rules: { change_below: -1.5 } }),
    category: 'options-puts',
    asset_class: 'option',
    education: 'Buy puts when momentum rolls over hard (-1.5% day). Day/swing horizon.',
    action: { side: 'buy', qty: 1, order_type: 'market', option_type: 'put', strike_target: 'atm', expiration: 'weekly' },
    default_symbols: ['TSLA', 'NVDA', 'SPY'],
  },

  // ── AI-driven ─────────────────────────────────────────────────────────────
  {
    ...SWING({ key: 'ai-conviction-swing', name: 'AI Conviction Swing', description: 'Claude-gated swing entries on confirmed uptrends.', rules: { price_above_sma20: true } }),
    category: 'ai',
    ai_gate: { enabled: true, min_conviction: 0.65 },
    education: 'Technical filter + Claude research must agree (conviction ≥ 0.65, positive sentiment).',
  },
  {
    ...SWING({ key: 'ai-catalyst-call', name: 'AI Catalyst — Long Call', description: 'Claude-gated bullish call buys on catalysts.', rules: { ema_cross: true } }),
    category: 'ai',
    asset_class: 'option',
    ai_gate: { enabled: true, min_conviction: 0.7 },
    education: 'Momentum trigger + high Claude conviction (≥ 0.7) → buy ATM weekly calls.',
    action: { side: 'buy', qty: 1, order_type: 'market', option_type: 'call', strike_target: 'atm', expiration: 'weekly' },
  },
];

/** Insert every template as a DISABLED bot for one account (env) if not already present.
 *  `mode` defaults to observe (the historical behaviour of the Strategy Library seed);
 *  a freshly seeded fleet passes 'cautious' so an enabled bot stages for approval. */
export async function seedStrategies(env: TradingEnv, opts: { mode?: Mode } = {}): Promise<{ created: number; skipped: number }> {
  const mode: Mode = opts.mode ?? 'observe';
  let created = 0;
  let skipped = 0;
  for (const s of STRATEGY_LIBRARY) {
    const existing = await q<{ id: number }>('SELECT id FROM bots WHERE env=:env AND name=:n LIMIT 1', { env, n: s.name });
    if (existing.length) {
      skipped++;
      continue;
    }
    await exec(
      `INSERT INTO bots (name, env, enabled, symbols, asset_class, rules, ai_gate, action, risk, mode)
       VALUES (:name,:env,0,CAST(:symbols AS JSON),:ac,CAST(:rules AS JSON),CAST(:ai AS JSON),CAST(:action AS JSON),CAST('{}' AS JSON),:mode)`,
      {
        name: s.name,
        env,
        mode,
        symbols: JSON.stringify(s.default_symbols),
        ac: s.asset_class,
        rules: JSON.stringify(s.rules),
        ai: JSON.stringify(s.ai_gate),
        action: JSON.stringify({ ...s.action, _strategy: s.key, _category: s.category, _timeframe: s.timeframe }),
      },
    );
    created++;
  }
  return { created, skipped };
}
