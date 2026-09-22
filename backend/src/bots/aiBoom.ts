/**
 * AI boom watch + call packs for the Alpaca paper desk.
 *
 * The in-repo artifact is the symbol census (Mag-7 fleet, quickbot universe,
 * strategy defaults, focus list). There is no closed-monitor dump in git.
 * Packs stay off full auto until deskRank sees a real winning sample.
 * Calls only. Non-LEAPS stay 2-14 DTE. Jev exit stays off.
 * GOOGL is the class share when a Mag-7 name is needed. Never GOOG.
 */

export type BoomLiquidity = 'listed' | 'unverified';
export type BoomKind = 'watch' | 'quickbot' | 'call' | 'leaps';

export type BoomSymbol = {
  symbol: string;
  group: 'chips' | 'power' | 'datacenter';
  /** listed: options are a normal US listing. unverified: on the watch until a human checks the chain. */
  liquidity: BoomLiquidity;
  note: string;
};

/** Research set. Trading packs only take `listed`. Thin names stay on the watch. */
export const AI_BOOM_SYMBOLS: BoomSymbol[] = [
  { symbol: 'AVGO', group: 'chips', liquidity: 'listed', note: 'Broadcom. Missing from the Mag-7 fleet, so the chips pack leads with it.' },
  { symbol: 'TSM', group: 'chips', liquidity: 'listed', note: 'Foundry. Listed options.' },
  { symbol: 'ASML', group: 'chips', liquidity: 'listed', note: 'Lithography. Listed options.' },
  { symbol: 'ARM', group: 'chips', liquidity: 'listed', note: 'CPU IP. Listed options.' },
  { symbol: 'SMCI', group: 'chips', liquidity: 'listed', note: 'Servers. Listed options, wide tape.' },
  { symbol: 'MU', group: 'chips', liquidity: 'listed', note: 'Memory. Already on the desk.' },
  { symbol: 'AMD', group: 'chips', liquidity: 'listed', note: 'CPU and accelerators. Already on the desk.' },
  { symbol: 'NVDA', group: 'chips', liquidity: 'listed', note: 'Accelerators. Already on the desk.' },
  { symbol: 'MRVL', group: 'chips', liquidity: 'listed', note: 'Custom silicon. Listed options.' },
  { symbol: 'ANET', group: 'chips', liquidity: 'listed', note: 'Networking. Listed options.' },
  { symbol: 'CRDO', group: 'chips', liquidity: 'unverified', note: 'Connectivity. Watch only until the option chain is checked.' },
  { symbol: 'VST', group: 'power', liquidity: 'listed', note: 'Power for AI load. Listed options.' },
  { symbol: 'CEG', group: 'power', liquidity: 'listed', note: 'Nuclear power. Already on the focus list.' },
  { symbol: 'NRG', group: 'power', liquidity: 'listed', note: 'Power retail and generation. Listed options.' },
  { symbol: 'VRT', group: 'power', liquidity: 'listed', note: 'Cooling and power. Listed options.' },
  { symbol: 'GEV', group: 'power', liquidity: 'unverified', note: 'Grid equipment. Watch only until the chain is checked.' },
  { symbol: 'EQIX', group: 'datacenter', liquidity: 'unverified', note: 'Datacenter REIT. Watch until the chain is checked.' },
  { symbol: 'DLR', group: 'datacenter', liquidity: 'unverified', note: 'Datacenter REIT. Watch until the chain is checked.' },
  { symbol: 'CCI', group: 'datacenter', liquidity: 'unverified', note: 'Towers. Watch until the chain is checked.' },
];

export const AI_BOOM_WATCH_NAME = 'AI Boom Watch';
export const AI_BOOM_WATCH_KEY = 'ai-boom-watch';
export const AVGO_CALL_NAME = 'AVGO Broadcom Call';
export const AVGO_LEAPS_NAME = 'AVGO LEAPS Call';
export const AI_CHIPS_PACK = 'AI Chips Call Pack';
export const AI_POWER_PACK = 'AI Power Call Pack';
export const AI_DATACENTER_PACK = 'AI Datacenter Call Pack';

export const AI_BOOM_QUICKBOT_NAMES = new Set([AI_CHIPS_PACK, AI_POWER_PACK, AI_DATACENTER_PACK]);

const PACK_USD = 900;

export type CoverageLists = {
  mag7: string[];
  universe: string[];
  strategySymbols: string[][];
  focus: string[];
};

export type CoveragePrior = {
  mag7: string[];
  universeMissing: string[];
  avgoInMag7: boolean;
  avgoInUniverse: boolean;
  powerInUniverse: string[];
  datacenterInUniverse: string[];
  googPresent: boolean;
  googlInMag7: boolean;
  note: string;
};

function upper(list: string[]): string[] {
  return [...new Set(list.map((s) => String(s || '').trim().toUpperCase()).filter(Boolean))];
}

/** Census of what the desk already trades. This is the in-repo history check. */
export function coveragePrior(lists: CoverageLists): CoveragePrior {
  const mag7 = upper(lists.mag7);
  const universe = upper(lists.universe);
  const focus = upper(lists.focus);
  const strat = upper(lists.strategySymbols.flat());
  const known = new Set([...mag7, ...universe, ...focus, ...strat]);
  const want = AI_BOOM_SYMBOLS.map((s) => s.symbol);
  const universeMissing = want.filter((s) => !universe.includes(s));
  const powerInUniverse = AI_BOOM_SYMBOLS.filter((s) => s.group === 'power' && universe.includes(s.symbol)).map((s) => s.symbol);
  const datacenterInUniverse = AI_BOOM_SYMBOLS.filter((s) => s.group === 'datacenter' && universe.includes(s.symbol)).map((s) => s.symbol);
  const googPresent = [...known].some((s) => s === 'GOOG');
  const avgoInMag7 = mag7.includes('AVGO');
  const avgoInUniverse = universe.includes('AVGO');
  const note = [
    `Mag-7 fleet is ${mag7.length} names${avgoInMag7 ? ' and includes AVGO' : ' and does not include AVGO'}.`,
    avgoInUniverse ? 'AVGO is already in the quickbot universe.' : 'AVGO is not in the quickbot universe.',
    powerInUniverse.length
      ? `Power names already in that universe: ${powerInUniverse.join(', ')}.`
      : 'Power names are absent from the quickbot universe.',
    datacenterInUniverse.length
      ? `Datacenter names already in that universe: ${datacenterInUniverse.join(', ')}.`
      : 'Datacenter names are absent from the quickbot universe.',
    'New packs stay off full auto until closed trades support them.',
  ].join(' ');
  return {
    mag7,
    universeMissing,
    avgoInMag7,
    avgoInUniverse,
    powerInUniverse,
    datacenterInUniverse,
    googPresent,
    googlInMag7: mag7.includes('GOOGL'),
    note,
  };
}

export function symbolsFor(group: BoomSymbol['group'], liquidity?: BoomLiquidity): string[] {
  return AI_BOOM_SYMBOLS
    .filter((s) => s.group === group && (liquidity == null || s.liquidity === liquidity))
    .map((s) => s.symbol);
}

export function watchSymbols(): string[] {
  return AI_BOOM_SYMBOLS.map((s) => s.symbol);
}

export type BoomBadge = string;

export type BoomPackView = {
  id: string;
  name: string;
  kind: BoomKind;
  symbols: string[];
  badges: BoomBadge[];
  fullAuto: false;
  jevExit: false;
  enabled: false;
};

const PAPER_OFF = ['paper', 'not full auto', 'Jev exit off'] as const;

export function aiBoomPacks(): BoomPackView[] {
  return [
    {
      id: 'watch',
      name: AI_BOOM_WATCH_NAME,
      kind: 'watch',
      symbols: watchSymbols(),
      badges: ['paper', 'watch only', 'no orders', 'Jev exit off'],
      fullAuto: false,
      jevExit: false,
      enabled: false,
    },
    {
      id: 'chips',
      name: AI_CHIPS_PACK,
      kind: 'quickbot',
      symbols: symbolsFor('chips', 'listed'),
      badges: ['paper', 'calls 2-14 DTE', 'not full auto', 'Jev exit off', 'AVGO included'],
      fullAuto: false,
      jevExit: false,
      enabled: false,
    },
    {
      id: 'power',
      name: AI_POWER_PACK,
      kind: 'quickbot',
      symbols: symbolsFor('power', 'listed'),
      badges: ['paper', 'calls 2-14 DTE', 'not full auto', 'Jev exit off'],
      fullAuto: false,
      jevExit: false,
      enabled: false,
    },
    {
      id: 'datacenter',
      name: AI_DATACENTER_PACK,
      kind: 'quickbot',
      symbols: symbolsFor('datacenter'),
      badges: ['paper', 'calls 2-14 DTE', 'liquidity unverified', 'not full auto', 'Jev exit off'],
      fullAuto: false,
      jevExit: false,
      enabled: false,
    },
    {
      id: 'avgo-call',
      name: AVGO_CALL_NAME,
      kind: 'call',
      symbols: ['AVGO'],
      badges: [...PAPER_OFF.slice(0, 1), 'calls 2-14 DTE', 'not full auto', 'Jev exit off'],
      fullAuto: false,
      jevExit: false,
      enabled: false,
    },
    {
      id: 'avgo-leaps',
      name: AVGO_LEAPS_NAME,
      kind: 'leaps',
      symbols: ['AVGO'],
      badges: ['paper', 'LEAPS', 'not full auto', 'Jev exit off'],
      fullAuto: false,
      jevExit: false,
      enabled: false,
    },
  ];
}

export type AiBoomPublic = {
  note: string;
  prior: string;
  packs: BoomPackView[];
};

export function aiBoomPublic(priorNote: string): AiBoomPublic {
  return {
    note: 'Paper only. Calls, or the LEAPS bot as already designed. Hard stop and the +1.5% gain-lock still win. Jev exit stays off and still logs.',
    prior: priorNote,
    packs: aiBoomPacks(),
  };
}

export type BoomPlay = {
  name: string;
  key: string;
  direction: 'call';
  dte: number;
  strike_target: 'atm';
  rules: Record<string, unknown>;
  risk: Record<string, number>;
};

/** Two call baselines at 7 DTE. No puts. Size stays at one contract and $900. */
export function boomCallPlays(): BoomPlay[] {
  const risk = {
    tp: 20,
    sl: 10,
    trail: 10,
    take_profit_pct: 20,
    stop_loss_pct: 10,
    trailing_stop_pct: 10,
    max_position_usd: PACK_USD,
    qty: 1,
  };
  return [
    {
      name: 'CALL Up-momentum · 7DTE',
      key: 'momo_up',
      direction: 'call',
      dte: 7,
      strike_target: 'atm',
      rules: { change_above: 0.8 },
      risk: { ...risk },
    },
    {
      name: 'CALL Breakout in uptrend · 7DTE',
      key: 'breakout_up',
      direction: 'call',
      dte: 7,
      strike_target: 'atm',
      rules: { breakout_high: true, price_above_sma20: true, require_all: true },
      risk: { ...risk },
    },
  ];
}

export function boomRisk(liquidity: BoomLiquidity): Record<string, unknown> {
  return {
    override: true,
    max_position_usd: PACK_USD,
    max_concentration_pct: 25,
    max_daily_loss_pct: 25,
    max_orders_per_day: 4,
    stop_loss_pct: 10,
    take_profit_pct: 20,
    trailing_stop_pct: 10,
    hold_overnight: true,
    hold_over_weekend: true,
    jev: { entry: false, exit: false },
    _ai_boom: true,
    _liquidity: liquidity,
  };
}

export type BoomInsert = {
  name: string;
  mode: 'observe' | 'cautious';
  enabled: 0;
  symbols: string[];
  asset_class: 'option';
  rules: Record<string, unknown>;
  action: Record<string, unknown>;
  risk: Record<string, unknown>;
};

function symbolPlays(symbols: string[]): Record<string, BoomPlay[]> {
  const plays = boomCallPlays();
  const out: Record<string, BoomPlay[]> = {};
  for (const s of symbols) out[s] = plays.map((p) => ({ ...p, rules: { ...p.rules }, risk: { ...p.risk } }));
  return out;
}

export function aiBoomInserts(): BoomInsert[] {
  const watchSyms = watchSymbols();
  const chips = symbolsFor('chips', 'listed');
  const power = symbolsFor('power', 'listed');
  const dc = symbolsFor('datacenter');
  return [
    {
      name: AI_BOOM_WATCH_NAME,
      mode: 'observe',
      enabled: 0,
      symbols: watchSyms,
      asset_class: 'option',
      rules: { price_above_sma20: true, _observe_only: true, _strategy: AI_BOOM_WATCH_KEY },
      action: {
        side: 'buy',
        qty: 1,
        order_type: 'market',
        option_type: 'call',
        strike_target: 'atm',
        expiration: 'weekly',
        _strategy: AI_BOOM_WATCH_KEY,
        _category: 'ai',
        _observe_only: true,
        _ai_boom: true,
        _pack: 'watch',
      },
      risk: { ...boomRisk('listed'), _observe_only: true, max_position_usd: 0 },
    },
    {
      name: AVGO_CALL_NAME,
      mode: 'cautious',
      enabled: 0,
      symbols: ['AVGO'],
      asset_class: 'option',
      rules: { breakout_high: true, price_above_sma20: true, require_all: true },
      action: {
        side: 'buy',
        qty: 1,
        order_type: 'market',
        option_type: 'call',
        strike_target: 'atm',
        expiration: 'weekly',
        _strategy: 'avgo-call',
        _category: 'options-calls',
        _ai_boom: true,
        _pack: 'avgo',
        _liquidity: 'listed',
      },
      risk: boomRisk('listed'),
    },
    {
      name: AVGO_LEAPS_NAME,
      mode: 'cautious',
      enabled: 0,
      symbols: ['AVGO'],
      asset_class: 'option',
      rules: { golden_cross: true },
      action: {
        side: 'buy',
        qty: 1,
        order_type: 'market',
        option_type: 'call',
        strike_target: 'itm',
        expiration: 'leaps',
        _strategy: 'avgo-leaps',
        _category: 'options-calls',
        _ai_boom: true,
        _pack: 'avgo-leaps',
        _liquidity: 'listed',
      },
      risk: boomRisk('listed'),
    },
    quickInsert(AI_CHIPS_PACK, chips, 'listed', 'chips'),
    quickInsert(AI_POWER_PACK, power, 'listed', 'power'),
    quickInsert(AI_DATACENTER_PACK, dc, 'unverified', 'datacenter'),
  ];
}

function quickInsert(name: string, symbols: string[], liquidity: BoomLiquidity, pack: string): BoomInsert {
  const plays = boomCallPlays();
  return {
    name,
    mode: liquidity === 'unverified' ? 'observe' : 'cautious',
    enabled: 0,
    symbols,
    asset_class: 'option',
    rules: {},
    action: {
      _quickbot: true,
      _category: 'quickbot',
      _ai_boom: true,
      _pack: pack,
      _liquidity: liquidity,
      _research: symbols[0] || null,
      _needs_tuning: true,
      side: 'buy',
      option_type: 'call',
      plays,
      symbol_plays: symbolPlays(symbols),
    },
    risk: boomRisk(liquidity),
  };
}
