/**
 * Build research-backed 2x–10x options playbooks from REAL 3-month data, store
 * each as a playbook + a matching (disabled, observe) bot, then backtest it.
 *   npm run seed:playbooks
 *
 * Long options only (calls = bullish, puts = bearish) — defined risk = premium.
 * These are HIGH-RISK, low-probability/high-payoff speculative setups.
 */
import { exec, q, pool } from '../db.js';
import { analyzeSymbolStats } from '../market/analyze.js';
import { backtestBot } from '../backtest.js';

// Today is the reference; expirations below are upcoming Fridays.
const EXP = {
  weekly: { date: '2026-06-26', label: 'June 26, 2026' },
  biweekly: { date: '2026-07-10', label: 'July 10, 2026' },
  monthly: { date: '2026-07-17', label: 'July 17, 2026' },
};

function strike(last: number, kind: 'atm' | 'otm_call' | 'otm_put' | 'itm_call'): number {
  const step = last >= 200 ? 5 : last >= 50 ? 2.5 : 1;
  const raw =
    kind === 'otm_call' ? last * 1.04 :
    kind === 'otm_put' ? last * 0.96 :
    kind === 'itm_call' ? last * 0.97 : last;
  return Math.round(raw / step) * step;
}

type PB = {
  symbol: string;
  title: string;
  category: 'swing' | 'day';
  option_type: 'call' | 'put';
  exp: keyof typeof EXP;
  strikeKind: 'atm' | 'otm_call' | 'otm_put' | 'itm_call';
  target: string;
  rules: Record<string, any>;
  timeframe: string;
  thesis: (a: any) => string;
  trigger: string;
  risk: string;
};

const PLAYS: PB[] = [
  {
    symbol: 'MSFT', title: 'MSFT Oversold Bounce — Long Call', category: 'swing', option_type: 'call',
    exp: 'weekly', strikeKind: 'atm', target: '2–4x', rules: { rsi_below: 30 }, timeframe: '1Day',
    trigger: 'RSI(14) < 30 then a green reclaim day',
    thesis: (a) => `MSFT is deeply oversold (RSI ${a.indicators?.rsi14?.toFixed(0)}) after a ${a.period_return_pct}% 3-mo slide to $${a.last}. Mean-reversion bounces in a mega-cap from RSI<25 are sharp; an ATM weekly call captures a snap back toward the 20-day (~+4-6%) for a 2–4x on the premium.`,
    risk: 'Catching a falling knife — if it keeps sliding the call decays fast. Stop if MSFT closes below the recent swing low; weekly theta is brutal if the bounce stalls.',
  },
  {
    symbol: 'AMD', title: 'AMD Trend-Pullback — Long Call', category: 'swing', option_type: 'call',
    exp: 'monthly', strikeKind: 'otm_call', target: '3–7x', rules: { ema_cross: true, price_above_sma20: true, min_matches: 1 }, timeframe: '1Day',
    trigger: 'Pullback to rising EMA21, then EMA9 reclaims EMA21',
    thesis: (a) => `AMD is the momentum leader: +${a.period_return_pct}% in 3 months with a ${a.max_gain_pct}% peak-to-trough swing and ${a.annualized_vol_pct}% vol. Buying an OTM monthly call on a pullback-and-reclaim rides the trend; with this vol, a +10-15% leg can return 3–7x.`,
    risk: 'IV/premium is rich after a 150% run — you pay up for vol. A trend break or sector rotation can halve the position quickly. Size small.',
  },
  {
    symbol: 'QQQ', title: 'QQQ Breakout — Long Call', category: 'swing', option_type: 'call',
    exp: 'monthly', strikeKind: 'otm_call', target: '2–3x', rules: { breakout_high: true }, timeframe: '1Day',
    trigger: '20-day high breakout with MACD support',
    thesis: (a) => `QQQ is in a clean uptrend (+${a.period_return_pct}% 3-mo, trend ${a.trend}). Index moves are smaller (${a.annualized_vol_pct}% vol), so use a monthly OTM call on a fresh 20-day-high breakout to let the trend work — realistic 2–3x.`,
    risk: 'Index vol is low, so a stall just bleeds theta. Avoid chasing extended breakouts; require the breakout candle to hold.',
  },
  {
    symbol: 'META', title: 'META Downtrend Continuation — Long Put', category: 'swing', option_type: 'put',
    exp: 'monthly', strikeKind: 'otm_put', target: '2–5x', rules: { bollinger_upper: true, rsi_above: 55, min_matches: 1 }, timeframe: '1Day',
    trigger: 'Bounce into resistance (upper band / RSI 55+) then roll over',
    thesis: (a) => `META is in a ${a.trend}trend, -${Math.abs(a.period_return_pct)}% over 3 months with a ${Math.abs(a.max_drawdown_pct)}% drawdown. Fading bounces into resistance with an OTM monthly put targets a retest of the lows; a -8-12% leg returns 2–5x.`,
    risk: 'Oversold bounces can squeeze hard against shorts/puts. Only enter on a failed bounce, not into falling support.',
  },
  {
    symbol: 'TSLA', title: 'TSLA Range Fade — Long Put', category: 'swing', option_type: 'put',
    exp: 'weekly', strikeKind: 'atm', target: '2–4x', rules: { bollinger_upper: true, rsi_above: 60, min_matches: 1 }, timeframe: '1Day',
    trigger: 'Rally to upper band / RSI > 60 inside the range',
    thesis: (a) => `TSLA is range-bound (${a.trend}) but very volatile (${a.annualized_vol_pct}% vol, ${a.avg_daily_range_pct}% avg daily range). Fading rallies to the top of the range with a weekly ATM put captures the snap back to mid-range for 2–4x.`,
    risk: 'A real breakout above the range turns the put to near-zero fast. Keep it weekly and exit if range high breaks on volume.',
  },
  {
    symbol: 'TSLA', title: 'TSLA Range Reclaim — Long Call', category: 'day', option_type: 'call',
    exp: 'weekly', strikeKind: 'atm', target: '2–4x', rules: { bollinger_lower: true }, timeframe: '5m',
    trigger: 'Flush to lower band / range support then reclaim',
    thesis: (a) => `The flip side of TSLA's range: buy weekly ATM calls when it flushes to the lower band and reclaims. With ${a.avg_daily_range_pct}% daily range, an intraday/2-day bounce to mid-range is a quick 2–4x.`,
    risk: 'Day-trade horizon — gamma & theta both high. Hard stop on a lower-low break; don\'t hold a losing weekly overnight.',
  },
  {
    symbol: 'META', title: 'META Oversold Snapback — Long Call', category: 'day', option_type: 'call',
    exp: 'weekly', strikeKind: 'atm', target: '2–3x', rules: { rsi_below: 35 }, timeframe: '1Day',
    trigger: 'RSI < 35 then intraday reclaim of prior day high',
    thesis: (a) => `Counter-trend scalp: META RSI is ${a.indicators?.rsi14?.toFixed(0)}. Even in a downtrend, RSI<35 produces tradable 1-3 day bounces. A weekly ATM call on the reclaim targets a fast 2–3x, then out.`,
    risk: 'Counter-trend in a downtrend — lowest probability here. Tight time stop (1–2 days); treat as a scalp, not a swing.',
  },
  {
    symbol: 'SPY', title: 'SPY Momentum Breakout — Long Call', category: 'swing', option_type: 'call',
    exp: 'monthly', strikeKind: 'otm_call', target: '2x', rules: { breakout_high: true, macd_positive: true, min_matches: 2 }, timeframe: '1Day',
    trigger: '20-day high + positive MACD (both)',
    thesis: (a) => `SPY grinds (+${a.period_return_pct}%, low ${a.annualized_vol_pct}% vol). 2x+ needs a clean catalyst-driven breakout, so require BOTH a 20-day high and positive MACD, and use a monthly OTM call to give it room. Realistic target ~2x, not 5x.`,
    risk: 'Lowest-vol name — the hardest to multiply. If it chops after entry, theta wins. Best used as a trend add, small size.',
  },
  {
    symbol: 'AMD', title: 'AMD Day-Momentum — Long Call', category: 'day', option_type: 'call',
    exp: 'weekly', strikeKind: 'atm', target: '2–3x', rules: { change_above: 2, macd_positive: true, min_matches: 1 }, timeframe: '5m',
    trigger: 'Opening-range breakout / +2% intraday with MACD up',
    thesis: (a) => `AMD's ${a.avg_daily_range_pct}% average daily range makes it a prime day-trade vehicle. A weekly ATM call on an opening-range/+2% breakout can do 2–3x same-session on gamma.`,
    risk: 'Same-day theta/gamma — must be disciplined: hard intraday stop, no overnight hold. High commission/slippage drag if overtraded.',
  },
  {
    symbol: 'QQQ', title: 'QQQ Trend-Break Hedge — Long Put', category: 'swing', option_type: 'put',
    exp: 'monthly', strikeKind: 'otm_put', target: '2–3x', rules: { breakdown_low: true }, timeframe: '1Day',
    trigger: '20-day low breakdown (trend fails)',
    thesis: (a) => `Insurance/contrarian: QQQ is extended (+${a.period_return_pct}%). If the uptrend cracks (20-day-low breakdown), an OTM monthly put pays 2–3x on a -5-8% pullback and hedges long exposure elsewhere.`,
    risk: 'Fighting a strong uptrend — most of the time this expires worthless. Only triggers on an actual breakdown; treat as tail hedge.',
  },
];

async function main() {
  // Clear prior generated playbooks/bots for idempotency.
  await exec("DELETE FROM playbooks");
  await exec("DELETE FROM bots WHERE env='alpaca_paper' AND (name LIKE '%— Long Call%' OR name LIKE '%— Long Put%')");

  for (const p of PLAYS) {
    const a = await analyzeSymbolStats(p.symbol, 90);
    if (!a) { console.log('skip', p.symbol, '(no data)'); continue; }
    const k = strike(a.last, p.strikeKind);
    const exp = EXP[p.exp];
    const action = {
      side: 'buy', qty: 1, order_type: 'market', option_type: p.option_type,
      strike_target: p.strikeKind === 'atm' ? 'atm' : (p.option_type === 'put' ? 'otm' : 'otm'),
      expiration: p.exp === 'weekly' ? 'weekly' : 'monthly',
      _category: 'options-' + (p.option_type === 'call' ? 'calls' : 'puts'),
      _timeframe: p.timeframe,
    };
    // Matching bot (disabled, observe).
    const botRes = await exec(
      `INSERT INTO bots (name, env, enabled, symbols, asset_class, rules, ai_gate, action, risk, mode)
       VALUES (:name,'alpaca_paper',0,CAST(:sym AS JSON),'option',CAST(:rules AS JSON),CAST('{"enabled":false}' AS JSON),CAST(:action AS JSON),CAST('{}' AS JSON),'observe')`,
      { name: p.title, sym: JSON.stringify([p.symbol]), rules: JSON.stringify(p.rules), action: JSON.stringify(action) },
    );
    const botId = botRes.insertId;

    const setup = {
      readable: `${exp.label}, $${k} ${p.option_type}`,
      option_type: p.option_type, strike: k, expiration: exp.date, expiration_label: exp.label,
      trigger: p.trigger, timeframe: p.timeframe, horizon: p.category,
    };
    const stats = {
      last: a.last, period_return_pct: a.period_return_pct, annualized_vol_pct: a.annualized_vol_pct,
      max_gain_pct: a.max_gain_pct, max_drawdown_pct: a.max_drawdown_pct, trend: a.trend,
      rsi14: a.indicators?.rsi14 != null ? Math.round(a.indicators.rsi14) : null,
    };
    await exec(
      `INSERT INTO playbooks (symbol,title,category,side,option_type,horizon,target_multiple,thesis,setup,stats,risk,bot_id)
       VALUES (:symbol,:title,:cat,'buy',:ot,:horizon,:tm,:thesis,CAST(:setup AS JSON),CAST(:stats AS JSON),:risk,:bid)`,
      {
        symbol: p.symbol, title: p.title, cat: p.category, ot: p.option_type, horizon: p.category,
        tm: p.target, thesis: p.thesis(a), setup: JSON.stringify(setup), stats: JSON.stringify(stats),
        risk: p.risk, bid: botId,
      },
    );

    // Backtest the bot on 90 days and attach modeled metrics.
    const bt = await backtestBot({ id: botId, name: p.title, symbols: JSON.stringify([p.symbol]), asset_class: 'option', rules: JSON.stringify(p.rules), action: JSON.stringify(action) }, { days: 90 });
    const m = bt.aggregate.metrics;
    console.log(
      (p.symbol + '   ').slice(0, 5),
      (p.title).padEnd(34),
      `${setup.readable.padEnd(24)} | trades ${String(m.num_trades).padStart(2)} | win ${String(m.win_rate).padStart(4)}% | total ${String(m.total_return_pct).padStart(7)}% | best ${m.best_multiple}x | ≥2x:${m.trades_2x}`,
    );
  }
  await pool.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
