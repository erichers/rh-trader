/**
 * Macro-cycle research + bots. Thesis: consensus reads the Fed as hawkish (June 17
 * 2026 hold at 3.50–3.75%, hawkish dot-plot under new chair Warsh), while the user's
 * contrarian view is a dovish pivot / rate cuts into 2027 — bullish for rate-sensitive
 * tech + the AI-memory supercycle (Micron). Iran on/off keeps vol elevated → dips to
 * buy + rich premium to sell. Long-dated LEAPS calls express the macro upside.
 *   npm run seed:macro
 *
 * Long calls are fully supported. The covered-call income leg is a SHORT (written)
 * call — documented + tracked here, but it requires broker options-writing permission
 * and is NOT auto-executed by the long-only agentic path (created in Observe).
 */
import { exec, q, pool } from '../db.js';
import { analyzeSymbolStats } from '../market/analyze.js';
import { backtestBot } from '../backtest.js';

const SRC = {
  fed: { label: 'CNBC — Fed June 17 2026', url: 'https://www.cnbc.com/2026/06/17/fed-interest-rate-decision-june-2026.html' },
  warsh: { label: 'Fox — Warsh era begins', url: 'https://www.foxbusiness.com/economy/federal-reserve-interest-rate-decision-june-17-2026' },
  muHBM: { label: 'Micron HBM sold-out / AI tailwinds', url: 'https://tickeron.com/blogs/micron-technology-mu-sold-out-hbm-supply-and-ai-tailwinds-point-to-strong-2026-growth-12100/' },
  muSuper: { label: 'Micron AI memory supercycle', url: 'https://thetechmarketer.com/micron-stock-price-mu-2026/' },
};

type Note = { symbol: string; title: string; stance: string; horizon: string; analysis: string; catalysts: string[]; rec: string; sources: any[] };
const NOTES: Note[] = [
  {
    symbol: 'MACRO', title: 'Macro cycle — dovish-pivot bet vs hawkish consensus', stance: 'bullish', horizon: 'position (6–9 mo)',
    analysis:
      'CONSENSUS (the fade): On June 17, 2026 the FOMC held the funds rate at 3.50–3.75% in Kevin Warsh\'s first meeting, and the dot-plot turned hawkish — median moved to 3.8% (from 3.4% in March), the 2026 cut was removed, and a hike is back on the table. Markets read this as hawkish. ' +
      'THESIS (contrarian): if Warsh ultimately pivots dovish and cuts arrive into late-2026/2027 (growth wobble, disinflation, or political pressure), rate-sensitive tech and the AI-capex complex re-rate higher. Long-dated LEAPS calls on QQQ/SPY/MU give convex, defined-risk exposure to that pivot without timing the exact meeting. ' +
      'VOL OVERLAY: Iran on/off headlines keep oil and index vol elevated — that means (a) sharp dips to accumulate via a daily dip-buyer, and (b) richer call premium to sell against a long position (covered-call income).',
    catalysts: ['FOMC meetings (next dot-plot revisions)', 'Warsh communication / dovish tells', 'Iran/oil geopolitical headlines', 'AI-capex & memory pricing ("memflation")', 'CPI / jobs prints'],
    rec: 'Core: ITM LEAPS calls (Dec 2026 / Mar 2027) on QQQ, SPY, MU. Tactical: daily dip-buyer on Iran-driven selloffs. Income: sell monthly OTM calls against the position (covered) to harvest elevated IV.',
    sources: [SRC.fed, SRC.warsh, SRC.muHBM],
  },
  {
    symbol: 'MU', title: 'Micron — AI memory supercycle into earnings (Jun 24)', stance: 'bullish', horizon: 'position + event',
    analysis:
      'Micron reports fiscal Q3 2026 on June 24, 2026. The setup is a memory supercycle: HBM is reported sold out for 2026 (HBM3e + HBM4 under binding contracts), with HBM4 volume ramping for NVIDIA platforms and Micron targeting ~20–25% HBM share by late 2026. Tight DRAM/NAND supply ("memflation") is lifting pricing hard. This is the highest-beta way to play both the AI-memory cycle and a dovish-pivot re-rate. Expect a large post-earnings move — size for it.',
    catalysts: ['FY Q3 earnings Jun 24, 2026', 'HBM4 ramp for NVIDIA', 'DRAM/NAND pricing ("memflation")', 'AI datacenter capex'],
    rec: 'Core: ITM Mar-2027 LEAPS call (stock replacement). Event: small ATM/OTM weekly call into earnings only if you want the gamma — beware IV crush. Income: sell monthly OTM calls vs the LEAPS once the move settles.',
    sources: [SRC.muHBM, SRC.muSuper],
  },
];

type BotDef = {
  name: string; symbols: string[]; rules: any; action: any; risk: any;
  playbook: { stance: string; horizon: string; target: string; thesis: string; rec: string; risk: string; sources: any[] };
};
const BOTS: BotDef[] = [
  {
    name: 'MU LEAPS — AI memory supercycle (Mar 2027 call)',
    symbols: ['MU'], rules: { price_above_sma20: true, ema_cross: true, min_matches: 1 },
    action: { side: 'buy', qty: 1, order_type: 'market', option_type: 'call', strike_target: 'itm', expiration: '2027-03-19', _category: 'options-calls', _timeframe: '1Day' },
    risk: { max_position_usd: 3000, take_profit_pct: 120, stop_loss_pct: 50, trailing_stop_pct: 40 },
    playbook: { stance: 'bullish', horizon: 'LEAPS (to Mar 2027)', target: '2–4x', thesis: 'ITM Mar-2027 call as a stock-replacement on the memory supercycle + dovish-pivot beta. Deep-ITM (~0.7+ delta) tracks the shares with less capital and slow theta.', rec: 'Enter on trend confirmation (price>SMA20 / EMA9>EMA21). Hold as a position; trail 40%.', risk: 'Earnings gap risk (Jun 24) and a hawkish-Fed shock. LEAPS lose value slowly but a -20% underlying move hurts. Defined risk = premium.', sources: [SRC.muHBM, SRC.muSuper] },
  },
  {
    name: 'QQQ LEAPS — dovish-pivot beta (Mar 2027 call)',
    symbols: ['QQQ'], rules: { price_above_sma20: true, breakout_high: true, min_matches: 1 },
    action: { side: 'buy', qty: 1, order_type: 'market', option_type: 'call', strike_target: 'itm', expiration: '2027-03-19', _category: 'options-calls', _timeframe: '1Day' },
    risk: { max_position_usd: 4000, take_profit_pct: 80, stop_loss_pct: 40, trailing_stop_pct: 30 },
    playbook: { stance: 'bullish', horizon: 'LEAPS (to Mar 2027)', target: '2–3x', thesis: 'Nasdaq-100 ITM LEAPS to capture an AI-capex + rate-cut re-rate. Index = lower vol than single names, so use ITM for delta and ride the trend.', rec: 'Add on breakouts / pullbacks-to-trend; this is the core macro position.', risk: 'If the Fed stays hawkish and the AI trade wobbles, QQQ can draw down 10–15%. Trail 30%.', sources: [SRC.fed] },
  },
  {
    name: 'SPY LEAPS — broad dovish bet (Dec 2026 call)',
    symbols: ['SPY'], rules: { price_above_sma20: true, macd_positive: true, require_all: true },
    action: { side: 'buy', qty: 1, order_type: 'market', option_type: 'call', strike_target: 'itm', expiration: '2026-12-18', _category: 'options-calls', _timeframe: '1Day' },
    risk: { max_position_usd: 4000, take_profit_pct: 60, stop_loss_pct: 35, trailing_stop_pct: 25 },
    playbook: { stance: 'bullish', horizon: 'LEAPS (to Dec 2026)', target: '~2x', thesis: 'Lowest-vol core: ITM Dec-2026 SPY call as a leveraged-but-defined broad-market hold for the dovish-pivot scenario.', rec: 'Trend-only entries (price>SMA20 AND MACD+). Smallest expected multiple but highest hit-rate.', risk: 'Low vol → modest upside; mainly a hedge-with-convexity on the macro view.', sources: [SRC.fed, SRC.warsh] },
  },
  {
    name: 'Macro Dip-Buyer (daily) — Iran-vol oversold calls',
    symbols: ['SPY', 'QQQ', 'MU'], rules: { rsi_below: 35, min_matches: 1 },
    action: { side: 'buy', qty: 1, order_type: 'market', option_type: 'call', strike_target: 'atm', expiration: 'weekly', _category: 'options-calls', _timeframe: '1Day' },
    risk: { max_position_usd: 600, take_profit_pct: 60, stop_loss_pct: 50, trailing_stop_pct: 30 },
    playbook: { stance: 'bullish', horizon: 'day / short swing', target: '2–4x', thesis: 'Geopolitical (Iran) selloffs overshoot. Buy weekly ATM calls when RSI flushes below 35 and accumulate the bounce — a tactical complement to the LEAPS core.', rec: 'Daily timeframe; let the trailing stop lock gains. Pair with the LEAPS so dips also add to the core.', risk: 'Counter-trend in a real risk-off leg can keep falling; weekly theta is fast. Keep size small.', sources: [SRC.fed] },
  },
  {
    name: 'Covered-Call Income — sell OTM calls vs holdings (overlay)',
    symbols: ['MU', 'QQQ', 'SPY'], rules: { rsi_above: 60, bollinger_upper: true, min_matches: 1 },
    action: { side: 'sell', qty: 1, order_type: 'market', option_type: 'call', strike_target: 'otm', expiration: 'monthly', covered: true, _category: 'income', _timeframe: '1Day' },
    risk: { max_position_usd: 0 },
    playbook: { stance: 'neutral', horizon: 'monthly income', target: 'premium yield', thesis: 'When you HOLD the underlying (shares or a deep LEAPS), sell a monthly OTM call into strength (RSI>60 / upper band) to harvest elevated IV. This is a covered/poor-man\'s covered call — income that lowers your cost basis.', rec: 'Sell ~30-delta monthly calls above resistance; roll up/out if tested. Only when covered.', risk: '⚠ This SELLS (writes) a call — a SHORT option. It is only safe when COVERED by 100 shares (or a deep LEAPS) per contract. The long-only agentic path will NOT auto-write this; enable options-writing at your broker and place it manually, or keep this bot in Observe as an alert. Caps your upside above the strike.', sources: [] },
  },
];

async function main() {
  // Research notes.
  for (const n of NOTES) {
    const a = n.symbol === 'MACRO' ? null : await analyzeSymbolStats(n.symbol, 90).catch(() => null);
    const stats = a ? { last: a.last, period_return_pct: a.period_return_pct, annualized_vol_pct: a.annualized_vol_pct, trend: a.trend, rsi14: a.indicators?.rsi14 != null ? Math.round(a.indicators.rsi14) : null } : {};
    await exec(
      `INSERT INTO research_notes (symbol,title,trend,stance,horizon,analysis,catalysts,recommended_strategy,stats,sources)
       VALUES (:s,:t,:tr,:st,:h,:a,CAST(:c AS JSON),:rs,CAST(:stats AS JSON),CAST(:src AS JSON))
       ON DUPLICATE KEY UPDATE trend=:tr,stance=:st,horizon=:h,analysis=:a,catalysts=CAST(:c AS JSON),recommended_strategy=:rs,stats=CAST(:stats AS JSON),sources=CAST(:src AS JSON)`,
      { s: n.symbol, t: n.title, tr: (a?.trend || 'macro'), st: n.stance, h: n.horizon, a: n.analysis, c: JSON.stringify(n.catalysts), rs: n.rec, stats: JSON.stringify(stats), src: JSON.stringify(n.sources) },
    );
    console.log('note:', n.symbol, '-', n.title);
  }

  // Micron earnings event.
  await exec(
    `INSERT INTO earnings (symbol,report_date,period_label,status,confirmed,eps_estimate,revenue,guidance,transcript_summary,source,source_url)
     VALUES ('MU','2026-06-24','FY Q3 2026','upcoming',1,'consensus beat expected (HBM)','sharply higher YoY (HBM-led)','HBM sold out 2026; HBM4 ramp for NVIDIA; ~81% GM guide cited','AI-memory supercycle; DRAM/NAND "memflation" lifting pricing into 2026','Tickeron / TheTechMarketer',:url)
     ON DUPLICATE KEY UPDATE report_date='2026-06-24',status='upcoming',confirmed=1,guidance=VALUES(guidance),transcript_summary=VALUES(transcript_summary),source_url=:url`,
    { url: SRC.muHBM.url },
  );
  console.log('earnings: MU FY Q3 2026 2026-06-24');

  // Bots + playbooks + backtests.
  for (const b of BOTS) {
    // CLI seeder: always the paper fleet (never touches a live account's bots).
    const existing = await q<{ id: number }>("SELECT id FROM bots WHERE env='alpaca_paper' AND name=:n LIMIT 1", { n: b.name });
    let botId: number;
    if (existing.length) {
      botId = existing[0].id;
      await exec("UPDATE bots SET symbols=CAST(:sym AS JSON), asset_class=:ac, rules=CAST(:rules AS JSON), action=CAST(:action AS JSON), risk=CAST(:risk AS JSON) WHERE id=:id AND env='alpaca_paper'",
        { id: botId, sym: JSON.stringify(b.symbols), ac: 'option', rules: JSON.stringify(b.rules), action: JSON.stringify(b.action), risk: JSON.stringify(b.risk) });
    } else {
      const r = await exec(
        `INSERT INTO bots (name, env, enabled, symbols, asset_class, rules, ai_gate, action, risk, mode)
         VALUES (:name,'alpaca_paper',0,CAST(:sym AS JSON),'option',CAST(:rules AS JSON),CAST('{"enabled":false}' AS JSON),CAST(:action AS JSON),CAST(:risk AS JSON),'observe')`,
        { name: b.name, sym: JSON.stringify(b.symbols), rules: JSON.stringify(b.rules), action: JSON.stringify(b.action), risk: JSON.stringify(b.risk) });
      botId = r.insertId;
    }
    const a = await analyzeSymbolStats(b.symbols[0], 90).catch(() => null);
    const pb = b.playbook;
    await exec(
      `INSERT INTO playbooks (symbol,title,category,side,option_type,horizon,target_multiple,thesis,setup,stats,risk,bot_id)
       VALUES (:symbol,:title,:cat,:side,:ot,:horizon,:tm,:thesis,CAST(:setup AS JSON),CAST(:stats AS JSON),:risk,:bid)
       ON DUPLICATE KEY UPDATE thesis=:thesis,setup=CAST(:setup AS JSON),risk=:risk,bot_id=:bid`,
      {
        symbol: b.symbols[0], title: b.name, cat: b.action._category, side: b.action.side, ot: b.action.option_type,
        horizon: pb.horizon, tm: pb.target, thesis: pb.thesis,
        setup: JSON.stringify({ readable: `${b.symbols.join('/')} ${b.action.option_type} ${b.action.strike_target} ${b.action.expiration}`, recommended: pb.rec, sources: pb.sources, expiration: b.action.expiration, option_type: b.action.option_type }),
        stats: JSON.stringify(a ? { last: a.last, trend: a.trend, vol: a.annualized_vol_pct } : {}),
        risk: pb.risk, bid: botId,
      },
    );

    // Backtest long-call bots with real option prices (skip the covered-call write).
    if (b.action.side === 'buy') {
      try {
        const bt = await backtestBot({ id: botId, name: b.name, symbols: JSON.stringify(b.symbols), asset_class: 'option', rules: JSON.stringify(b.rules), action: JSON.stringify(b.action), risk: JSON.stringify(b.risk) }, { days: 150, realOptions: true });
        const m = bt.aggregate.metrics;
        console.log((b.name).padEnd(48), `trades ${m.num_trades} | real ${m.real_priced ?? '-'} | total ${m.total_return_pct}% | best ${m.best_multiple}x`);
      } catch (e: any) { console.log(b.name, 'backtest err', e?.message); }
    } else {
      console.log((b.name).padEnd(48), '(income overlay — documented, Observe)');
    }
  }
  await pool.end();
}
main().catch((e) => { console.error(e); process.exit(1); });
