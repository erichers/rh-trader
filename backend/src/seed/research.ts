/**
 * Independent research desk — populated by Claude Code via web research + the
 * user's live Alpaca price data. REAL, sourced findings (not Alpaca's news feed,
 * not fabricated). Run: npm run seed:research
 *
 * Facts gathered 2026-06-21 via web search (sources attached per row). Trend
 * stats are pulled live from Alpaca at seed time.
 */
import { exec, pool } from '../db.js';
import { analyzeSymbolStats } from '../market/analyze.js';

type Note = {
  symbol: string; title: string; stance: 'bullish' | 'bearish' | 'neutral'; horizon: string;
  analysis: string; catalysts: string[]; recommended_strategy: string; sources: { label: string; url: string }[];
};

const NOTES: Note[] = [
  {
    symbol: 'TSLA', title: 'Tesla — robotaxi optionality into Q2 print', stance: 'neutral', horizon: 'swing / event',
    analysis:
      'Range-bound and very volatile (~41% annualized vol). Q1 2026 (reported Apr 22) was a slight miss — EPS $0.41 adj vs $0.37 est on $22.39B rev vs $22.64B est, with deliveries light. The bull case is robotaxi: paid robotaxi miles roughly doubled QoQ and unsupervised service went live in Austin, Dallas and Houston. Street models ~420k Q2 deliveries (+10% YoY) and ~$0.50–0.52 EPS vs $0.45 consensus. This is a binary, headline-driven name — the July delivery number and the Jul 22 print are the swing points.',
    catalysts: ['Q2 deliveries (early July)', 'Q2 earnings Jul 22, 2026', 'Unsupervised FSD / robotaxi geographic expansion', 'Cybercab / Semi / Megapack 3 volume ramp (2026)'],
    recommended_strategy: 'Range play: fade rallies to the top of the range with weekly puts, buy reclaims off support with weekly calls. Into Jul 22 earnings, prefer defined-risk weekly options sized small (IV crush risk).',
    sources: [
      { label: 'CNBC — Tesla Q1 2026', url: 'https://www.cnbc.com/2026/04/22/tesla-tsla-q1-2026-earnings-report.html' },
      { label: 'Investing.com — robotaxi/Q2 outlook', url: 'https://www.investing.com/news/stock-market-news/tesla-needs-to-deliver-on-robotaxi-milestones-for-shares-to-find-momentum-analyst-4747680' },
    ],
  },
  {
    symbol: 'META', title: 'Meta — strong ads, capex under the microscope', stance: 'bearish', horizon: 'swing',
    analysis:
      'Down ~14% over 3 months and trending lower (RSI ~36) despite excellent fundamentals. Q1 2026 (Apr 29) beat: revenue $56.31B (+33% YoY) vs $55.45B est; ex-tax EPS ~$7.31 vs $6.79 est; Q2 guide $58–61B. The overhang is spend: Meta raised 2026 capex guidance to $125–145B (from $115–135B), and the market is repricing AI capital intensity. Until the tape stabilizes, bounces into resistance are sellable.',
    catalysts: ['Q2 earnings ~Jul 29, 2026', 'AI capex trajectory ($125–145B 2026)', 'Ad revenue growth durability', 'Reality Labs losses'],
    recommended_strategy: 'Downtrend continuation: buy OTM monthly puts on failed bounces into resistance (upper Bollinger / RSI 50+). Flip to a quick oversold-bounce call only on an RSI<35 reclaim (scalp).',
    sources: [
      { label: 'CNBC — Meta Q1 2026', url: 'https://www.cnbc.com/2026/04/29/meta-q1-earnings-report-2026.html' },
      { label: 'Quartz — capex raised to $145B', url: 'https://qz.com/meta-q1-2026-earnings-ai-spending-capex-stock-042926' },
    ],
  },
  {
    symbol: 'MSFT', title: 'Microsoft — deeply oversold mega-cap', stance: 'bullish', horizon: 'swing (mean reversion)',
    analysis:
      'Down ~8% over 3 months with RSI ~19 — a deeply oversold reading rare for a $3T+ mega-cap and historically a high-probability bounce setup. Fundamentals remain driven by Azure + Copilot AI monetization and heavy AI capex. Next print is fiscal Q4 (quarter ended Jun 30), typically reported in late July (est ~Jul 29, unconfirmed). The setup is a mean-reversion bounce toward the 20-day average, not a trend trade.',
    catalysts: ['Fiscal Q4 earnings late July 2026 (est)', 'Azure / Copilot AI revenue', 'AI capex and margin trajectory', 'Oversold mean-reversion (RSI ~19)'],
    recommended_strategy: 'Oversold bounce: ATM weekly calls on an RSI<30 green reclaim day; tight time stop. Target a snap to the 20-day (~+4–6%) for a 2–4x on the premium.',
    sources: [{ label: 'Microsoft SEC 8-K (Q3 FY26)', url: 'https://www.sec.gov/Archives/edgar/data/0000789019/000119312526191457/msft-ex99_1.htm' }],
  },
  {
    symbol: 'AMD', title: 'AMD — momentum leader, AI GPU ramp', stance: 'bullish', horizon: 'swing / trend',
    analysis:
      'The standout: +151% over 3 months with ~73% annualized vol and a clean uptrend. The driver is the MI-series AI datacenter GPU ramp and share-of-wallet vs NVIDIA. Q1 2026 reported May 5; next print ~Aug 4 (unconfirmed). High realized vol means options are richly priced (you pay for IV), but pullbacks-to-trend have been the highest-expectancy setup in the book (backtested best of all bots).',
    catalysts: ['Q2 earnings ~Aug 4, 2026', 'MI350/MI400 AI GPU ramp', 'Datacenter GPU share vs NVIDIA', 'Hyperscaler AI capex'],
    recommended_strategy: 'Trend-pullback: buy OTM monthly calls when price pulls back to a rising EMA21 and EMA9 reclaims. Size small (rich IV). This is the "AMD Trend-Pullback — Long Call" playbook (best backtest).',
    sources: [{ label: 'AMD SEC 8-K (Q1 FY26)', url: 'https://www.sec.gov/Archives/edgar/data/0000002488/000000248826000072/q12026991.htm' }],
  },
  {
    symbol: 'QQQ', title: 'Nasdaq-100 — uptrend led by AI capex', stance: 'bullish', horizon: 'swing',
    analysis:
      'Clean uptrend, +21% over 3 months at a moderate ~21% vol. The index is carried by the AI-capex complex (NVDA, MSFT, META, AMD). Near-term risk events cluster late July (mega-cap earnings) and Aug 26 (NVIDIA fiscal Q2). Trend-following longs work until a 20-day-low breakdown signals a regime change.',
    catalysts: ['Mega-cap earnings cluster late July', 'NVIDIA earnings Aug 26, 2026', 'Fed rate path / FOMC', 'AI capex durability'],
    recommended_strategy: 'Breakout calls (monthly, slightly OTM) on fresh 20-day highs; keep a small OTM monthly put as a trend-break hedge if it loses the 20-day low.',
    sources: [{ label: 'NVIDIA earnings calendar', url: 'https://www.marketbeat.com/stocks/NASDAQ/NVDA/earnings/' }],
  },
  {
    symbol: 'SPY', title: 'S&P 500 — low-vol grind, event-gated', stance: 'neutral', horizon: 'swing',
    analysis:
      'Up ~8% over 3 months at low ~15% vol, chopping sideways near highs. Low realized vol makes 2x+ option payoffs hard without a catalyst, so directional premium is best deployed around events. The late-July mega-cap earnings cluster and the FOMC are the realistic vol catalysts.',
    catalysts: ['Late-July mega-cap earnings (MSFT/META/AAPL/AMZN)', 'FOMC / rate decision', 'CPI & jobs prints', 'AI capex theme'],
    recommended_strategy: 'Require a clean catalyst-driven breakout (20-day high + positive MACD) before buying monthly OTM calls; realistic target ~2x, not 5x. Otherwise stay flat — low vol bleeds premium.',
    sources: [{ label: 'Tech earnings calendar', url: 'https://techmarketbriefs.com/earnings/' }],
  },
];

const EARNINGS = [
  { symbol: 'TSLA', date: '2026-07-22', period: 'Q2 2026', status: 'upcoming', confirmed: 1, est: '~$0.50–0.52 (St. $0.45)', actual: null, rev: 'est ~$25B; ~420k deliveries', guidance: 'Analysts model +10% YoY deliveries; robotaxi expansion in focus.', transcript: 'Q1 2026 (Apr 22): EPS $0.41 adj vs $0.37 est; rev $22.39B vs $22.64B est; deliveries light. Robotaxi paid miles ~2x QoQ; unsupervised in Austin/Dallas/Houston.', src: 'CNBC', url: 'https://www.cnbc.com/2026/04/22/tesla-tsla-q1-2026-earnings-report.html' },
  { symbol: 'META', date: '2026-07-29', period: 'Q2 2026', status: 'upcoming', confirmed: 0, est: '~$7+ EPS', actual: null, rev: 'guided $58–61B', guidance: 'Q2 revenue guided $58–61B; 2026 capex $125–145B.', transcript: 'Q1 2026 (Apr 29): rev $56.31B (+33% YoY) vs $55.45B est; ex-tax EPS ~$7.31 vs $6.79 est. Capex outlook raised to $125–145B.', src: 'Quartz', url: 'https://qz.com/meta-q1-2026-earnings-ai-spending-capex-stock-042926' },
  { symbol: 'MSFT', date: '2026-07-29', period: 'FY Q4 2026', status: 'upcoming', confirmed: 0, est: 'TBD', actual: null, rev: 'TBD', guidance: 'Watch Azure growth + AI capex guide.', transcript: 'Reported fiscal Q3 (qtr ended Mar 31) in late April; this is the fiscal year-end print (est late July, unconfirmed).', src: 'Microsoft IR (SEC 8-K)', url: 'https://www.sec.gov/Archives/edgar/data/0000789019/000119312526191457/msft-ex99_1.htm' },
  { symbol: 'AMD', date: '2026-08-04', period: 'Q2 2026', status: 'upcoming', confirmed: 0, est: 'TBD', actual: null, rev: 'TBD', guidance: 'MI-series datacenter GPU ramp the key driver.', transcript: 'Q1 2026 reported May 5, 2026.', src: 'WallStreet Horizon', url: 'https://www.wallstreethorizon.com/amd-earnings-calendar' },
  { symbol: 'NVDA', date: '2026-08-26', period: 'Q2 FY2027', status: 'upcoming', confirmed: 1, est: 'TBD', actual: null, rev: 'TBD', guidance: 'Blackwell ramp; datacenter demand.', transcript: 'Confirmed for Aug 26, 2026 after market — key catalyst for QQQ/semis.', src: 'MarketBeat', url: 'https://www.marketbeat.com/stocks/NASDAQ/NVDA/earnings/' },
];

async function main() {
  for (const n of NOTES) {
    const a = await analyzeSymbolStats(n.symbol, 90).catch(() => null);
    const stats = a ? { last: a.last, period_return_pct: a.period_return_pct, annualized_vol_pct: a.annualized_vol_pct, max_gain_pct: a.max_gain_pct, max_drawdown_pct: a.max_drawdown_pct, trend: a.trend, rsi14: a.indicators?.rsi14 != null ? Math.round(a.indicators.rsi14) : null } : {};
    await exec(
      `INSERT INTO research_notes (symbol,title,trend,stance,horizon,analysis,catalysts,recommended_strategy,stats,sources)
       VALUES (:s,:t,:tr,:st,:h,:a,CAST(:c AS JSON),:rs,CAST(:stats AS JSON),CAST(:src AS JSON))
       ON DUPLICATE KEY UPDATE trend=:tr,stance=:st,horizon=:h,analysis=:a,catalysts=CAST(:c AS JSON),recommended_strategy=:rs,stats=CAST(:stats AS JSON),sources=CAST(:src AS JSON)`,
      { s: n.symbol, t: n.title, tr: (a?.trend || 'sideways'), st: n.stance, h: n.horizon, a: n.analysis, c: JSON.stringify(n.catalysts), rs: n.recommended_strategy, stats: JSON.stringify(stats), src: JSON.stringify(n.sources) },
    );
    console.log('note:', n.symbol, '-', n.title);
  }
  for (const e of EARNINGS) {
    await exec(
      `INSERT INTO earnings (symbol,report_date,period_label,status,confirmed,eps_estimate,eps_actual,revenue,guidance,transcript_summary,source,source_url)
       VALUES (:s,:d,:p,:st,:cf,:est,:act,:rev,:g,:tr,:src,:url)
       ON DUPLICATE KEY UPDATE report_date=:d,status=:st,confirmed=:cf,eps_estimate=:est,revenue=:rev,guidance=:g,transcript_summary=:tr,source=:src,source_url=:url`,
      { s: e.symbol, d: e.date, p: e.period, st: e.status, cf: e.confirmed, est: e.est, act: e.actual, rev: e.rev, g: e.guidance, tr: e.transcript, src: e.src, url: e.url },
    );
    console.log('earnings:', e.symbol, e.period, e.date);
  }
  await pool.end();
}
main().catch((e) => { console.error(e); process.exit(1); });
