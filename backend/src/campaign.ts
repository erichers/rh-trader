import { q, exec, audit } from './db.js';

// ─────────────────────────────────────────────────────────────────────────────
// Growth campaign: a documented, milestone-laddered plan to grow a small account
// aggressively (e.g. $1k → $100k) with phase-appropriate, defined-risk option
// strategies and day-by-day tracking. Long-only, no crypto (enforced by the risk
// engine regardless). This module owns the plan, the progress math, and the daily
// snapshot + coaching recommendation.
// ─────────────────────────────────────────────────────────────────────────────

export type Phase = {
  phase: number;
  name: string;
  range: [number, number];          // equity band this phase applies to
  objective: string;
  max_trades: number;               // concurrent open positions
  max_risk_per_trade_pct: number;   // % of account at risk per trade
  stop_premium_pct: number;         // hard stop on option premium
  take_profit_pct: number;          // scale-out target
  dte: string;                      // days-to-expiration guidance
  delta: string;                    // moneyness guidance
  playbook: string;                 // what to do, plainly
  bots: BotPreset[];                // recommended bots (deep-link to wizard)
};

export type BotPreset = {
  key: string;
  name: string;
  symbols: string[];
  asset_class: 'option' | 'equity';
  why: string;
  action?: { option_type?: 'call' | 'put'; strike_target?: 'itm' | 'atm' | 'otm'; expiration?: string };
  rules?: any;
  risk?: any;
};

/** Default 6-month, 100× ladder. Doubling milestones; risk tightens as size grows. */
function defaultMilestones(start: number, target: number) {
  const levels = [];
  let v = start;
  let i = 0;
  while (v < target) {
    levels.push({ level: i, target: Math.round(v), label: i === 0 ? 'Start' : `${Math.round(v / start)}×` });
    v *= 2;
    i++;
  }
  levels.push({ level: i, target: Math.round(target), label: `${Math.round(target / start)}× — GOAL` });
  return levels;
}

export function defaultPhases(): Phase[] {
  return [
    {
      phase: 1, name: 'Ignition', range: [0, 4000],
      objective: 'Catch 1–2 high-conviction catalyst moves to get to escape velocity.',
      max_trades: 2, max_risk_per_trade_pct: 25, stop_premium_pct: 50, take_profit_pct: 100,
      dte: '30–45 DTE', delta: '~0.40 (slightly OTM) or a debit call spread to cap cost',
      playbook: 'At this size, concentration is the point — but each trade is DEFINED-RISK (a long call or a debit spread, never naked). One conviction trade at a time until the account proves itself. Hard-stop at −50% of premium. Bank the position the moment it doubles; let a runner ride with a raised stop.',
      bots: [
        { key: 'ign-mu-calls', name: 'MU catalyst calls', symbols: ['MU'], asset_class: 'option', why: 'Memory/HBM supercycle leader; earnings + AI-capex catalysts.', action: { option_type: 'call', strike_target: 'otm', expiration: 'monthly' }, rules: { rsi_below: 45 }, risk: { max_position_usd: 250, stop_loss_pct: 50, take_profit_pct: 100, trailing_stop_pct: 35 } },
        { key: 'ign-nvda-calls', name: 'NVDA momentum calls', symbols: ['NVDA'], asset_class: 'option', why: 'AI compute bellwether; trend + breakout entries.', action: { option_type: 'call', strike_target: 'atm', expiration: 'monthly' }, rules: { ema_cross: 'golden' }, risk: { max_position_usd: 250, stop_loss_pct: 50, take_profit_pct: 100, trailing_stop_pct: 35 } },
      ],
    },
    {
      phase: 2, name: 'Momentum', range: [4000, 16000],
      objective: 'Compound winners; add a LEAPS core you can hold through the cycle.',
      max_trades: 3, max_risk_per_trade_pct: 15, stop_premium_pct: 45, take_profit_pct: 120,
      dte: 'swings 30–60 DTE + one LEAPS (Dec 2026 / Mar 2027)',
      delta: 'swings ~0.45; LEAPS ~0.60–0.70 (ITM, less theta)',
      playbook: 'Split the book: 1 LEAPS core (semis/AI) you hold for the macro move, plus 1–2 swing trades around catalysts. Take partials at +100–120%, roll up stops on the rest. Never let a green trade go red.',
      bots: [
        { key: 'mom-mu-leaps', name: 'MU LEAPS core', symbols: ['MU'], asset_class: 'option', why: 'Hold the supercycle: deep-ITM Dec26/Mar27 calls; lower theta.', action: { option_type: 'call', strike_target: 'itm', expiration: '2027-01-15' }, risk: { max_position_usd: 1500, stop_loss_pct: 40, take_profit_pct: 200, trailing_stop_pct: 30 } },
        { key: 'mom-ceg-power', name: 'CEG nuclear/AI-power calls', symbols: ['CEG'], asset_class: 'option', why: 'Beaten-down nuclear generator with TMI/Crane restart + Microsoft PPA; July NRC + earnings catalysts.', action: { option_type: 'call', strike_target: 'atm', expiration: 'monthly' }, risk: { max_position_usd: 800, stop_loss_pct: 45, take_profit_pct: 120, trailing_stop_pct: 30 } },
        { key: 'mom-megacap-swing', name: 'Mega-cap momentum swings (QQQ/SPY/META/TSLA)', symbols: ['QQQ', 'SPY', 'META', 'TSLA'], asset_class: 'option', why: 'More PREDICTABLE, liquid large-cap/index swings to smooth the curve between single-name catalysts; META carries the software/AI-comeback tilt, TSLA the robotaxi optionality.', action: { option_type: 'call', strike_target: 'atm', expiration: 'monthly' }, rules: { ema_cross: 'golden' }, risk: { max_position_usd: 800, stop_loss_pct: 45, take_profit_pct: 110, trailing_stop_pct: 30 } },
      ],
    },
    {
      phase: 3, name: 'Compounding', range: [16000, 50000],
      objective: 'Diversify catalysts, trade the macro calendar (FOMC, earnings, midterms), tighten risk.',
      max_trades: 4, max_risk_per_trade_pct: 10, stop_premium_pct: 40, take_profit_pct: 100,
      dte: '21–45 DTE for events; keep the LEAPS core',
      delta: '~0.40–0.50; debit spreads into known event dates to cap IV-crush risk',
      playbook: 'The account is now real money — protect it. Cap risk at 10%/trade, spread across 3–4 uncorrelated catalysts. Use debit spreads around earnings/FOMC to neutralize IV crush. Bank profits weekly; the LEAPS core keeps your macro exposure.',
      bots: [
        { key: 'cmp-spy-event', name: 'SPY event debit spreads', symbols: ['SPY'], asset_class: 'option', why: 'Defined-risk index plays around FOMC / CPI / midterm catalysts.', action: { option_type: 'call', strike_target: 'atm', expiration: 'monthly' }, risk: { max_position_usd: 2500, stop_loss_pct: 40, take_profit_pct: 90, trailing_stop_pct: 25 } },
        { key: 'cmp-dip-buyer', name: 'Macro dip-buyer', symbols: ['QQQ', 'SPY', 'NVDA', 'META', 'TSLA'], asset_class: 'option', why: 'Buy oversold bounces (RSI<35) in the leaders + liquid mega-caps during volatility.', action: { option_type: 'call', strike_target: 'otm', expiration: 'monthly' }, rules: { rsi_below: 35 }, risk: { max_position_usd: 2000, stop_loss_pct: 40, take_profit_pct: 100, trailing_stop_pct: 30 } },
      ],
    },
    {
      phase: 4, name: 'Preservation & Push', range: [50000, 1e9],
      objective: 'Lock gains, hedge event risk, push to $100k with measured leverage.',
      max_trades: 5, max_risk_per_trade_pct: 7, stop_premium_pct: 40, take_profit_pct: 80,
      dte: '21–45 DTE; add protective puts around the Nov election & war headlines',
      delta: '~0.35–0.45; carry a small long-put hedge as a tail guard',
      playbook: 'You are close — do not give it back. Drop per-trade risk to ~7%, diversify, and carry a cheap put hedge (SPY/QQQ) through the midterm window and any war-headline risk. Push the last leg with your best 1–2 setups, then declare victory.',
      bots: [
        { key: 'psh-hedge', name: 'Tail-risk put hedge', symbols: ['SPY'], asset_class: 'option', why: 'A long put guard for election/war volatility while you finish the climb.', action: { option_type: 'put', strike_target: 'otm', expiration: 'monthly' }, risk: { max_position_usd: 3000, stop_loss_pct: 60, take_profit_pct: 150, trailing_stop_pct: 40 } },
        { key: 'psh-best-ideas', name: 'Best-ideas calls', symbols: ['NVDA', 'MU', 'QQQ'], asset_class: 'option', why: 'Concentrate the final push in your 1–2 highest-conviction names.', action: { option_type: 'call', strike_target: 'atm', expiration: 'monthly' }, risk: { max_position_usd: 4000, stop_loss_pct: 40, take_profit_pct: 80, trailing_stop_pct: 25 } },
      ],
    },
  ];
}

const DEFAULT_THESIS =
  'H2 2026 is a collision of two forces. (1) The AI/semiconductor supercycle is still roaring — hyperscaler ' +
  '2026 capex ~$700B+, Micron sold out of HBM through 2026, memory in its tightest shortage in ~15 years; ' +
  'NVDA/AMD remain supply-constrained (mid-cycle on demand). (2) A Middle-East oil shock (Strait of Hormuz ' +
  'disruption) drove CPI back to ~4%+, which flipped the new Fed (Warsh) HAWKISH — the June dot plot implies the ' +
  'next move is a HIKE, not the cuts the market expected. Layer on the midterm-election-year pattern (historic ' +
  'Sept/Oct drawdown → strong post-election Q4 rally) and you get a choppy, headline-driven, high-dispersion tape: ' +
  'ideal terrain for CONVEX, DEFINED-RISK long-option bets concentrated in AI/memory, power/grid, nuclear, energy ' +
  'and defense — with put hedges into the Sept/Oct window. Long-only throughout (calls/LEAPS for upside, long puts ' +
  'for hedges). YOUR CONTRARIAN EDGE: if the Fed actually cuts (the dovish case), AI/growth calls get a second ' +
  'tailwind — keep the call side ready to size up on confirmation. Aggressive structures into a Q4 rally; protect ' +
  'capital through the Q3 volatility window. STABILITY SLEEVE: alongside the high-torque single-names, the plan ' +
  'trades liquid mega-caps/indices (QQQ, SPY, META, TSLA) for more predictable, repeatable swings — META carries ' +
  'the software/AI-platform comeback, TSLA the robotaxi optionality — to smooth the equity curve between catalysts.';

// Top research sources (from the deep macro brief — real, dated June 2026).
const DEFAULT_SOURCES = [
  'https://www.federalreserve.gov/monetarypolicy/fomcprojtabl20260617.htm',
  'https://www.cnbc.com/2026/05/15/traders-now-see-next-fed-interest-rate-move-as-a-hike-following-inflation-surge.html',
  'https://www.investing.com/analysis/microns-soldout-hbm-supply-makes-the-bull-case-hard-to-dismiss-200681391',
  'https://www.tomshardware.com/tech-industry/big-tech/big-techs-ai-spending-plans-reach-725-billion',
  'https://en.wikipedia.org/wiki/2026_Strait_of_Hormuz_crisis',
  'https://www.carsongroup.com/insights/blog/2026-outlook-riding-the-wave-is-here/',
];

// Catalyst calendar — the dates the campaign trades around (from the macro brief).
const CATALYSTS = [
  { date: '2026-06-24', event: 'Micron (MU) fiscal Q3 earnings', note: 'Purest memory-supercycle read; HBM/DRAM pricing, GM toward 80%.' },
  { date: '2026-07-08', event: 'NRC comment deadline — Crane/TMI restart', note: 'Bullish catalyst for CEG (nuclear/AI-power).' },
  { date: '2026-07-22', event: 'Tesla Q2 earnings', note: 'High-IV robotics/robotaxi optionality.' },
  { date: '2026-07-29', event: 'FOMC decision + META Q2 earnings', note: 'First Warsh-led action read; hyperscaler capex tone.' },
  { date: '2026-08-04', event: 'AMD Q2 earnings', note: 'MI450/Helios AI-accelerator ramp.' },
  { date: '2026-08', event: 'Hormuz 60-day MOU window expires', note: 'Binary oil catalyst → inflation & Fed path.' },
  { date: '2026-08-27', event: 'NVDA Q2 FY27 earnings (approx)', note: 'Largest single mover; Vera Rubin ramp.' },
  { date: '2026-09-16', event: 'FOMC + dot plot/SEP', note: 'Peak-volatility window; overlaps seasonal weakness — own hedges.' },
  { date: '2026-10-28', event: 'FOMC decision', note: 'Earliest plausible hike per positioning.' },
  { date: '2026-11-03', event: 'US midterm election', note: 'Policy-uncertainty resolution → historic Q4 rally trigger.' },
  { date: '2026-12-09', event: 'FOMC + final 2026 dot plot', note: 'Year-end verdict; sets 2027 backdrop.' },
];

const DEFAULT_RULES = {
  long_only: true, no_crypto: true, defined_risk_only: true,
  daily_loss_halt_pct: 15,        // stop trading for the day after −15% account drawdown
  per_trade_hard_stop: 'phase.stop_premium_pct',
  scale_out: 'take partials at the phase take-profit; trail the rest',
  never_average_down: true,
  position_sizing: 'risk = phase.max_risk_per_trade_pct of CURRENT equity, not starting equity',
  catalysts: CATALYSTS,
};

/** Create the campaign if none is active. Idempotent (returns the existing one). */
export async function seedCampaign(opts: { start?: number; target?: number; days?: number; today: string } = { today: '' }): Promise<any> {
  const existing = await getActiveCampaign();
  if (existing) return existing;
  const start = opts.start ?? 1000;
  const target = opts.target ?? 100000;
  const days = opts.days ?? 182;
  const today = opts.today || new Date().toISOString().slice(0, 10);
  const target_date = new Date(Date.parse(today + 'T00:00:00Z') + days * 864e5).toISOString().slice(0, 10);
  const res = await exec(
    `INSERT INTO campaigns (name, env, status, start_equity, target_equity, start_date, target_date, thesis, milestones, phases, rules, sources)
     VALUES (:name,:env,'active',:se,:te,:sd,:td,:thesis,CAST(:ms AS JSON),CAST(:ph AS JSON),CAST(:rules AS JSON),CAST(:src AS JSON))`,
    {
      name: `$${(start / 1000).toFixed(0)}k → $${(target / 1000).toFixed(0)}k in ${Math.round(days / 30)} months`,
      // The campaign always tracks the Robinhood agentic (real-money) account.
      env: 'robinhood_live',
      se: start, te: target, sd: today, td: target_date,
      thesis: DEFAULT_THESIS,
      ms: JSON.stringify(defaultMilestones(start, target)),
      ph: JSON.stringify(defaultPhases()),
      rules: JSON.stringify(DEFAULT_RULES),
      src: JSON.stringify(DEFAULT_SOURCES),
    },
  );
  await seedCampaignResearch().catch(() => {});
  await audit('campaign.create', `seeded campaign ${res.insertId}: ${start}→${target}`);
  return getActiveCampaign();
}

export async function getActiveCampaign(): Promise<any> {
  const [c] = await q<any>("SELECT * FROM campaigns WHERE status='active' ORDER BY id DESC LIMIT 1");
  return c ?? null;
}

export async function getArmedCampaign(): Promise<any> {
  const [c] = await q<any>("SELECT * FROM campaigns WHERE status='armed' ORDER BY id DESC LIMIT 1");
  return c ?? null;
}

// A deposit below this is dust, not the campaign stake — don't start the clock on it.
const MIN_FUNDING_USD = 25;

/** RE-ARM the campaign: archive any active/armed run and stage a fresh one that does NOT
 *  start until the Robinhood account is actually funded. start_equity/start_date stay NULL —
 *  they're set from the REAL deposit the moment it lands (via activateArmedIfFunded). */
export async function armCampaign(opts: { target?: number; days?: number } = {}): Promise<any> {
  const target = opts.target ?? 100000;
  const days = opts.days ?? 182;
  await exec("UPDATE campaigns SET status='archived' WHERE status IN ('active','armed')");
  const res = await exec(
    `INSERT INTO campaigns (name, env, status, start_equity, target_equity, start_date, target_date, thesis, milestones, phases, rules, sources)
     VALUES (:name,'robinhood_live','armed',NULL,:te,NULL,NULL,:thesis,CAST('[]' AS JSON),CAST(:ph AS JSON),CAST(:rules AS JSON),CAST(:src AS JSON))`,
    {
      name: `Deposit → $${(target / 1000).toFixed(0)}k in ${Math.round(days / 30)} months (armed)`,
      te: target, thesis: DEFAULT_THESIS,
      ph: JSON.stringify(defaultPhases()), rules: JSON.stringify({ ...DEFAULT_RULES, arm_days: days }),
      src: JSON.stringify(DEFAULT_SOURCES),
    },
  );
  await audit('campaign.arm', `campaign armed → $${target.toLocaleString()} target; starts automatically when Robinhood is funded (≥$${MIN_FUNDING_USD})`);
  return getArmedCampaign();
}

/** Called by the worker after each broker sync: the instant the Robinhood account shows a
 *  real deposit, the armed campaign goes live — start equity = the ACTUAL deposit, clock
 *  starts that day, milestones recomputed from the real numbers. */
export async function activateArmedIfFunded(): Promise<any | null> {
  const armed = await getArmedCampaign();
  if (!armed) return null;
  const [a] = await q<{ equity: number }>("SELECT equity FROM accounts WHERE env='robinhood_live' AND equity IS NOT NULL ORDER BY updated_at DESC LIMIT 1");
  const equity = Number(a?.equity ?? 0);
  if (!(equity >= MIN_FUNDING_USD)) return null;
  const rules = J(armed.rules, {});
  const days = Number(rules.arm_days) || 182;
  const target = Math.max(Number(armed.target_equity) || 100000, equity); // never target below funding
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  const target_date = new Date(Date.parse(today + 'T00:00:00Z') + days * 864e5).toISOString().slice(0, 10);
  await exec(
    `UPDATE campaigns SET status='active', start_equity=:se, start_date=:sd, target_date=:td,
       name=:name, milestones=CAST(:ms AS JSON) WHERE id=:id`,
    {
      id: armed.id, se: equity, sd: today, td: target_date,
      name: `$${equity >= 1000 ? (equity / 1000).toFixed(1).replace(/\.0$/, '') + 'k' : Math.round(equity)} → $${(target / 1000).toFixed(0)}k in ${Math.round(days / 30)} months`,
      ms: JSON.stringify(defaultMilestones(equity, target)),
    },
  );
  await audit('campaign.start', `deposit detected ($${equity.toLocaleString()}) — campaign LIVE: $${Math.round(equity)} → $${target.toLocaleString()} by ${target_date}`);
  const { raiseAlert } = await import('./alerts.js');
  await raiseAlert({
    level: 'info', source: 'system', title: `Campaign STARTED: $${Math.round(equity).toLocaleString()} → $${(target / 1000).toFixed(0)}k`,
    body: `Robinhood deposit detected. The clock starts today (${today}); target date ${target_date}. Phase 1 rules apply — see the Growth Plan tab.`, dedupMin: 0,
  }).catch(() => {});
  await recordSnapshot().catch(() => {});
  return getActiveCampaign();
}

// Per-ticker research from the deep macro brief (real, sourced, June 2026).
const CAMPAIGN_RESEARCH: { symbol: string; stance: string; trend: string; analysis: string; catalyst: string; structure: string; sources: string[] }[] = [
  { symbol: 'MU', stance: 'bullish', trend: 'up', analysis: 'Purest memory-supercycle play: sold out of HBM through 2026, tightest memory shortage in ~15 years, DRAM/NAND ASPs ripping with gross margin guided toward ~80%. Risk is a CY2027 capex decel / HBM oversupply if yields break higher.', catalyst: '2026-06-24 — fiscal Q3 earnings (HBM volume, Q4 guide, GM vs 80%)', structure: 'Earnings: small defined-risk debit call spread (IV very high). Trend: Dec 2026 / Jan 2027 ~30–40Δ calls bought on post-earnings dips.', sources: ['https://www.investing.com/analysis/microns-soldout-hbm-supply-makes-the-bull-case-hard-to-dismiss-200681391', 'https://www.tradingkey.com/analysis/stocks/us-stocks/261979099-micron-q3-earnings-preview-gross-margin-expected-break-80-mark-tradingkey'] },
  { symbol: 'NVDA', stance: 'bullish', trend: 'up', analysis: 'AI-cycle anchor; still supply- not demand-constrained. Vera Rubin ramping to early customers H2 2026. Defines overall risk appetite for the semi complex.', catalyst: '~2026-08-27 — Q2 FY27 earnings; Rubin ramp commentary', structure: 'LEAPS (Jan 2027/2028 60–70Δ) as core; debit call spreads around earnings to cap IV cost.', sources: ['https://www.tomshardware.com/tech-industry/big-tech/big-techs-ai-spending-plans-reach-725-billion', 'https://www.ssga.com/us/en/institutional/insights/ai-capex-cycle-may-have-more-staying-power'] },
  { symbol: 'AMD', stance: 'bullish', trend: 'up', analysis: 'Second derivative of AI compute demand with more torque than NVDA: MI450/Helios rack-scale ramp + first 1GW OpenAI deployment in H2 2026.', catalyst: '2026-08-04 — Q2 earnings; H2 MI450 deployments', structure: 'Dec 2026 / Mar 2027 ~30–40Δ calls or debit call spreads.', sources: ['https://www.tomshardware.com/tech-industry/big-tech/big-techs-ai-spending-plans-reach-725-billion'] },
  { symbol: 'CEG', stance: 'bullish', trend: 'up', analysis: 'Cleanest AI-power value setup: beaten-down nuclear generator with TMI/Crane restart + a 20-yr Microsoft PPA. Rate-sensitive but fundamentally backed by record PJM capacity prices and data-center demand.', catalyst: '2026-07-08 NRC comment deadline; 2026-07-30 Q2 earnings', structure: 'Sep/Dec 2026 ~35–45Δ calls into the July NRC + earnings catalysts.', sources: ['https://www.utilitydive.com/news/pjm-capacity-auction-2026-data-centers/', 'https://ir.constellationenergy.com/'] },
  { symbol: 'XLE', stance: 'bullish', trend: 'up', analysis: 'Energy levered to a Hormuz re-closure oil spike; positive carry and +29% YTD. Acts as both offense on geopolitics and a portfolio hedge — it rallies on the same shocks that hurt broad equities.', catalyst: '~2026-08 — Hormuz MOU window expiry; ongoing Iran risk', structure: 'Sep–Dec 2026 OTM calls as a convex oil-shock hedge (cheaper after spot pulled back from the May peak).', sources: ['https://en.wikipedia.org/wiki/2026_Strait_of_Hormuz_crisis', 'https://tradingeconomics.com/commodity/brent-crude-oil'] },
  { symbol: 'ITA', stance: 'bullish', trend: 'up', analysis: 'Defense ETF riding NATO’s 5%-of-GDP spending ramp plus active multi-theater conflict — a structural tailwind; recent pullback is an entry.', catalyst: 'Ongoing NATO/Ukraine/Iran spending; quarterly defense earnings', structure: 'Dec 2026 / 2027 LEAPS calls (slower mover, lower IV — buy time, not gamma).', sources: ['https://247wallst.com/investing/2026/04/16/3-defense-etfs-to-buy-as-nato-spending-hits-record-highs-in-2026/'] },
  { symbol: 'SPY', stance: 'bearish', trend: 'down', analysis: 'Index HEDGE vehicle: midterm-year Q2–Q3 drawdown risk (historic ~17–18% intra-year, Sept/Oct bottom) + a hawkish Fed + a live geopolitical tail argue for owning downside before September, then rolling into the post-election Q4 rally with calls.', catalyst: 'Sept–Oct 2026 seasonal weakness; 2026-09-16 FOMC', structure: 'Aug–Oct 2026 OTM put spreads (defined-cost drawdown hedge); flip to calls into the Q4 rally.', sources: ['https://www.carsongroup.com/insights/blog/2026-outlook-riding-the-wave-is-here/', 'https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm'] },
];

/** Upsert the campaign's per-ticker research into research_notes (real, sourced). */
export async function seedCampaignResearch(): Promise<number> {
  let n = 0;
  for (const r of CAMPAIGN_RESEARCH) {
    await exec(
      `INSERT INTO research_notes (symbol, title, trend, stance, horizon, analysis, catalysts, recommended_strategy, sources, author)
       VALUES (:s,:t,:tr,:st,'2026-H2',:a,CAST(:cat AS JSON),:rec,CAST(:src AS JSON),'campaign-macro-brief')
       ON DUPLICATE KEY UPDATE trend=:tr, stance=:st, analysis=:a, catalysts=CAST(:cat AS JSON), recommended_strategy=:rec, sources=CAST(:src AS JSON)`,
      { s: r.symbol, t: `${r.symbol} — H2 2026 macro thesis`, tr: r.trend, st: r.stance, a: r.analysis,
        cat: JSON.stringify([r.catalyst]), rec: r.structure, src: JSON.stringify(r.sources) },
    );
    n++;
  }
  return n;
}

function J(v: any, d: any) { if (v == null) return d; if (typeof v === 'object') return v; try { return JSON.parse(v); } catch { return d; } }

/** Normalize a MySQL DATE (returned as a JS Date at LOCAL midnight) or string to
 *  'YYYY-MM-DD'. Use LOCAL components — toISOString() would roll back a day in
 *  timezones behind UTC and skew the pace curve. */
function dstr(d: any): string {
  if (!d) return '';
  if (d instanceof Date) {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }
  return String(d).slice(0, 10);
}
function dms(d: any): number { return Date.parse(dstr(d) + 'T00:00:00Z'); }

/** The on-track equity for a given day, on the exponential start→target curve. */
export function targetEquityOn(campaign: any, dateISO: string): number {
  const start = Number(campaign.start_equity) || 1;
  const target = Number(campaign.target_equity) || start;
  const sd = dms(campaign.start_date);
  const td = dms(campaign.target_date);
  const now = dms(dateISO);
  const T = Math.max(1, td - sd);
  const frac = Math.max(0, Math.min(1, (now - sd) / T));
  return Math.round(start * Math.pow(target / start, frac));
}

export function phaseFor(campaign: any, equity: number): Phase {
  const phases: Phase[] = J(campaign.phases, defaultPhases());
  return phases.find((p) => equity >= p.range[0] && equity < p.range[1]) || phases[phases.length - 1];
}

/** Current equity of the account this campaign tracks (latest snapshot for its env). */
async function currentEquity(campaign: any): Promise<number> {
  const [a] = await q<{ equity: number }>(
    'SELECT equity FROM accounts WHERE env=:env ORDER BY updated_at DESC LIMIT 1', { env: campaign.env },
  );
  return Number(a?.equity ?? 0);
}

/** Full campaign view + computed progress, used by the dashboard. */
export async function campaignView(): Promise<any> {
  const campaign = await getActiveCampaign();
  if (!campaign) {
    // An ARMED campaign is staged but not started: the clock begins the moment a real
    // Robinhood deposit lands (worker checks after every broker sync).
    const armed = await getArmedCampaign();
    if (armed) {
      const [a] = await q<{ equity: number }>("SELECT equity FROM accounts WHERE env='robinhood_live' AND equity IS NOT NULL ORDER BY updated_at DESC LIMIT 1");
      return {
        active: false, armed: true, id: armed.id, name: armed.name, env: armed.env,
        target_equity: Number(armed.target_equity), rh_equity: Number(a?.equity ?? 0),
        note: 'Waiting for your Robinhood deposit — the campaign starts automatically (start equity = the actual deposit, clock starts that day). Until then, bots practice on paper.',
      };
    }
    return null;
  }
  const today = new Date().toISOString().slice(0, 10);
  const equity = await currentEquity(campaign);
  const start = Number(campaign.start_equity);
  const target = Number(campaign.target_equity);
  const onTrack = targetEquityOn(campaign, today);
  const phase = phaseFor(campaign, Math.max(equity, start));
  const milestones = J(campaign.milestones, []);
  const nextMs = milestones.find((m: any) => m.target > equity) || milestones[milestones.length - 1];
  const daysElapsed = Math.max(0, Math.round((dms(today) - dms(campaign.start_date)) / 864e5));
  const daysLeft = Math.max(0, Math.round((dms(campaign.target_date) - dms(today)) / 864e5));
  const snapshots = await q<any>('SELECT * FROM campaign_snapshots WHERE campaign_id=:id ORDER BY snap_date ASC', { id: campaign.id });
  const multipleToGo = equity > 0 ? target / equity : target / start;
  return {
    ...campaign,
    milestones, phases: J(campaign.phases, []), rules: J(campaign.rules, {}), sources: J(campaign.sources, []),
    progress: {
      equity, start, target, onTrack,
      pct_to_goal: Math.round((equity / target) * 10000) / 100,
      pace: equity >= onTrack ? 'ahead' : 'behind',
      pace_delta: Math.round(equity - onTrack),
      current_phase: phase,
      next_milestone: nextMs,
      multiple_to_go: Math.round(multipleToGo * 10) / 10,
      days_elapsed: daysElapsed,
      days_left: daysLeft,
      recommendation: recommendation(campaign, equity, onTrack, phase),
    },
    snapshots,
  };
}

/** Plain-spoken daily coaching based on pace + phase. */
export function recommendation(campaign: any, equity: number, onTrack: number, phase: Phase): string {
  const start = Number(campaign.start_equity);
  if (equity <= 0) {
    return `Fund the agentic account with the starting $${start.toLocaleString()} to begin. Until then this is a paper plan — practice the Phase 1 setups (${phase.bots.map((b) => b.name).join(', ')}) on the Paper env.`;
  }
  const ahead = equity >= onTrack;
  const lead = ahead
    ? `You're AHEAD of pace (${fmt(equity)} vs ${fmt(onTrack)} on-track). Bank profits and don't get greedy — protect the lead.`
    : `You're BEHIND pace (${fmt(equity)} vs ${fmt(onTrack)} on-track). Do NOT chase with bigger size — wait for an A+ setup that fits Phase ${phase.phase}.`;
  return `${lead} Phase ${phase.phase} (${phase.name}): risk ≤${phase.max_risk_per_trade_pct}% of equity per trade (~${fmt(equity * phase.max_risk_per_trade_pct / 100)}), ≤${phase.max_trades} open at once, hard stop −${phase.stop_premium_pct}% on premium, scale at +${phase.take_profit_pct}%. ${phase.playbook}`;
}

function fmt(n: number): string { return '$' + Math.round(n).toLocaleString(); }

/**
 * Record (or update) today's tracking snapshot. Called by the worker once a day
 * and on-demand from the UI. `deposits` lets the user log capital they added.
 */
export async function recordSnapshot(opts: { date?: string; deposits?: number; note?: string } = {}): Promise<any> {
  const campaign = await getActiveCampaign();
  if (!campaign) return null;
  const date = opts.date || new Date().toISOString().slice(0, 10);
  const equity = await currentEquity(campaign);
  const [acct] = await q<{ cash: number }>('SELECT cash FROM accounts WHERE env=:env ORDER BY updated_at DESC LIMIT 1', { env: campaign.env });
  const [prev] = await q<any>(
    'SELECT equity FROM campaign_snapshots WHERE campaign_id=:id AND snap_date < :d ORDER BY snap_date DESC LIMIT 1',
    { id: campaign.id, d: date },
  );
  const deposits = Number(opts.deposits ?? 0);
  const prevEq = Number(prev?.equity ?? campaign.start_equity);
  const pnlDay = Math.round((equity - prevEq - deposits) * 100) / 100;
  const pnlTotal = Math.round((equity - Number(campaign.start_equity)) * 100) / 100;
  const onTrack = targetEquityOn(campaign, date);
  const phase = phaseFor(campaign, Math.max(equity, Number(campaign.start_equity)));
  const rec = recommendation(campaign, equity, onTrack, phase);
  await exec(
    `INSERT INTO campaign_snapshots (campaign_id, snap_date, equity, cash, deposits, pnl_day, pnl_total, target_equity_today, phase, recommendation, note)
     VALUES (:id,:d,:eq,:cash,:dep,:pd,:pt,:tt,:ph,:rec,:note)
     ON DUPLICATE KEY UPDATE equity=:eq, cash=:cash, deposits=:dep, pnl_day=:pd, pnl_total=:pt, target_equity_today=:tt, phase=:ph, recommendation=:rec, note=COALESCE(:note,note)`,
    {
      id: campaign.id, d: date, eq: equity, cash: Number(acct?.cash ?? 0), dep: deposits,
      pd: pnlDay, pt: pnlTotal, tt: onTrack, ph: `${phase.phase} · ${phase.name}`, rec, note: opts.note ?? null,
    },
  );
  return { date, equity, deposits, pnl_day: pnlDay, pnl_total: pnlTotal, target_equity_today: onTrack, phase: phase.name, recommendation: rec };
}
