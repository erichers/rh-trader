/**
 * Fox Trading wait-for-signal adds for the Alpaca paper desk.
 *
 * These twelve names are the AI boom pack. They stay off (mode observe,
 * enabled 0) until a person arms them. Calls only, 2-14 DTE. Jev exit stays off.
 * SMCI buys only on a two-sided mid or an ask. Last and close do not size.
 * Deferred names are not seeded. The skip list is not added again.
 * GOOGL is the class share when a Mag-7 name is needed. Never GOOG.
 */

export const FOX_WAIT = ['TSM', 'ASML', 'ANET', 'VRT', 'ARM', 'MRVL', 'CEG', 'VST', 'EQIX', 'ORCL', 'ETN', 'SMCI'] as const;
export const FOX_DEFER = ['DLR', 'NRG', 'INTC', 'CLS', 'COHR'] as const;
export const FOX_SKIP = ['NVDA', 'AMD', 'AVGO', 'MU', 'META', 'MSFT', 'AMZN', 'TSLA', 'EOSE', 'RKLB'] as const;

export const FOX_PACK_NAME = 'Fox wait for signal';
export const FOX_PACK_ID = 'fox-wait';
export const FOX_STRICT_SYMBOL = 'SMCI';

/** Old pack names from the first boom seed. Retired on paper so they are not traded. */
export const RETIRED_BOOM_NAMES = [
  'AI Boom Watch',
  'AVGO Broadcom Call',
  'AVGO LEAPS Call',
  'AI Chips Call Pack',
  'AI Power Call Pack',
  'AI Datacenter Call Pack',
] as const;

/** Fox bots are not quickbots. An empty keep-set lets a force retune drop the old packs. */
export const AI_BOOM_QUICKBOT_NAMES = new Set<string>();

const PACK_USD = 900;

export function foxBotName(symbol: string): string {
  return `${String(symbol || '').trim().toUpperCase()} wait for signal`;
}

export type CoverageLists = {
  mag7: string[];
  universe: string[];
  strategySymbols: string[][];
  focus: string[];
};

export type CoveragePrior = {
  mag7: string[];
  wait: string[];
  deferred: string[];
  skipped: string[];
  alreadyOnDesk: string[];
  googPresent: boolean;
  googlInMag7: boolean;
  note: string;
};

function upper(list: string[]): string[] {
  return [...new Set(list.map((s) => String(s || '').trim().toUpperCase()).filter(Boolean))];
}

/** Census of what the desk already lists. This is the in-repo history check. */
export function coveragePrior(lists: CoverageLists): CoveragePrior {
  const mag7 = upper(lists.mag7);
  const universe = upper(lists.universe);
  const focus = upper(lists.focus);
  const strat = upper(lists.strategySymbols.flat());
  const known = new Set([...mag7, ...universe, ...focus, ...strat]);
  const alreadyOnDesk = FOX_WAIT.filter((s) => known.has(s));
  const googPresent = [...known].some((s) => s === 'GOOG');
  const note = [
    'Fox wait-for-signal adds stay off until you arm them.',
    `Twelve paper bots: ${FOX_WAIT.join(', ')}.`,
    `Deferred, not seeded: ${FOX_DEFER.join(', ')}.`,
    `Not added again: ${FOX_SKIP.join(', ')}.`,
    alreadyOnDesk.length
      ? `Already on a desk list: ${alreadyOnDesk.join(', ')}.`
      : 'None of the twelve are on the Mag-7 fleet or the quickbot universe.',
    'SMCI needs a two-sided mid or an ask. Last and close do not size a buy.',
  ].join(' ');
  return {
    mag7,
    wait: [...FOX_WAIT],
    deferred: [...FOX_DEFER],
    skipped: [...FOX_SKIP],
    alreadyOnDesk,
    googPresent,
    googlInMag7: mag7.includes('GOOGL'),
    note,
  };
}

export type BoomBadge = string;

export type BoomPackView = {
  id: string;
  name: string;
  kind: 'wait';
  symbols: string[];
  badges: BoomBadge[];
  fullAuto: false;
  jevExit: false;
  enabled: false;
};

export function aiBoomPacks(): BoomPackView[] {
  return [
    {
      id: FOX_PACK_ID,
      name: FOX_PACK_NAME,
      kind: 'wait',
      symbols: [...FOX_WAIT],
      badges: ['paper', 'off', 'wait for signal', 'calls 2-14 DTE', 'Jev exit off', 'SMCI strict price'],
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
  deferred: string[];
  skipped: string[];
};

export function aiBoomPublic(priorNote: string): AiBoomPublic {
  return {
    note: 'Paper only. Twelve wait-for-signal call bots, default off. Calls, 2-14 DTE. Hard stop and the +1.5% gain-lock still win. Jev exit stays off and still logs. SMCI buys only on a two-sided mid or an ask.',
    prior: priorNote,
    packs: aiBoomPacks(),
    deferred: [...FOX_DEFER],
    skipped: [...FOX_SKIP],
  };
}

export function boomRisk(symbol: string): Record<string, unknown> {
  const strict = symbol === FOX_STRICT_SYMBOL;
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
    _wait_for_signal: true,
    _fox: 'wait',
    ...(strict ? { _strict_price: true } : {}),
  };
}

export type BoomInsert = {
  name: string;
  mode: 'observe';
  enabled: 0;
  symbols: string[];
  asset_class: 'option';
  rules: Record<string, unknown>;
  action: Record<string, unknown>;
  risk: Record<string, unknown>;
};

export function aiBoomInserts(): BoomInsert[] {
  return FOX_WAIT.map((symbol) => {
    const strict = symbol === FOX_STRICT_SYMBOL;
    return {
      name: foxBotName(symbol),
      mode: 'observe' as const,
      enabled: 0 as const,
      symbols: [symbol],
      asset_class: 'option' as const,
      rules: { breakout_high: true, price_above_sma20: true, require_all: true },
      action: {
        side: 'buy',
        qty: 1,
        order_type: 'market',
        option_type: 'call',
        strike_target: 'atm',
        expiration: 'weekly',
        _strategy: `fox-wait-${symbol.toLowerCase()}`,
        _category: 'options-calls',
        _ai_boom: true,
        _wait_for_signal: true,
        _fox: 'wait',
        _pack: FOX_PACK_ID,
        ...(strict ? { _strict_price: true } : {}),
      },
      risk: boomRisk(symbol),
    };
  });
}
