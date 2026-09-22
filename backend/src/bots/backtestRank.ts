/**
 * Fox backtest-rank shape (`fox.backtest_rank.v1`).
 *
 * One `rank` row is symbol × strategy × DTE, using the scores the desk
 * already computes (expectancy, trades, win rate, max drawdown, robust).
 * `preferred_bot_ids` is the measure order: paper fills on 86 (G4 NVDA),
 * 39 (Index QuickBot), then 88 (G8 trail). Those ids sort to the front of
 * `rank` when the row carries a bot id. Plays from the quickbot leaderboard
 * have a null bot id and follow the preferred bots.
 *
 * Read `fox_rank` on `GET /api/quickbots/leaderboard` or `POST /api/backtest/scan`.
 * See docs/FOX-BACKTEST-RANK.md.
 */

export const FOX_BACKTEST_RANK_SHAPE = 'fox.backtest_rank.v1';

/** Paper bots with real fills. Fox measures these before the rest of the grid. */
export const FOX_RANK_PREFERRED_BOTS = [86, 39, 88] as const;

export type BacktestRankKind = 'play' | 'bot';

export type BacktestRankRow = {
  kind: BacktestRankKind;
  symbol: string;
  strategy: string;
  label: string;
  dte: number | null;
  bot_id: number | null;
  expectancy_pct: number | null;
  trades: number;
  win_rate: number | null;
  max_drawdown_pct: number | null;
  total_return_pct: number | null;
  profit_factor: number | null;
  best_multiple: number | null;
  robust: boolean;
  modeled: boolean;
  preferred: boolean;
};

export type FoxBacktestRank = {
  shape: typeof FOX_BACKTEST_RANK_SHAPE;
  preferred_bot_ids: number[];
  preferred_note: string;
  rank: BacktestRankRow[];
};

const PREFERRED_NOTE = 'Measure these paper bots first. They have fills: 86 G4 NVDA, 39 Index QuickBot, 88 G8 trail. Then read rank (symbol × strategy × DTE).';

function numOrNull(v: unknown): number | null {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function preferredIndex(id: number | null): number {
  if (id == null) return FOX_RANK_PREFERRED_BOTS.length;
  const i = (FOX_RANK_PREFERRED_BOTS as readonly number[]).indexOf(id);
  return i === -1 ? FOX_RANK_PREFERRED_BOTS.length : i;
}

/** Map a quickbot leaderboard play or a strategy-scan bot row into the Fox DTO. */
export function mapBacktestRankRow(row: any): BacktestRankRow {
  const m = row?.metrics && typeof row.metrics === 'object' ? row.metrics : {};
  const rawId = row?.bot_id != null ? Number(row.bot_id) : null;
  const botId = rawId != null && Number.isFinite(rawId) ? rawId : null;
  const symbols = Array.isArray(row?.symbols) ? row.symbols : [];
  const symbol = String(row?.symbol || symbols[0] || '').toUpperCase();
  const strategy = String(row?.key || row?.strategy || row?.name || '');
  const dteRaw = row?.dte ?? m.dte;
  const dte = dteRaw != null && dteRaw !== '' && Number.isFinite(Number(dteRaw)) ? Number(dteRaw) : null;
  const kind: BacktestRankKind = row?.key || row?.strategy ? 'play' : 'bot';
  return {
    kind,
    symbol,
    strategy,
    label: String(row?.label || row?.name || strategy),
    dte,
    bot_id: botId,
    expectancy_pct: numOrNull(m.expectancy_pct ?? row?.expectancy_pct ?? m.avg_return_pct ?? row?.avg_return_pct),
    trades: Number(m.num_trades ?? row?.num_trades) || 0,
    win_rate: numOrNull(m.win_rate ?? row?.win_rate),
    max_drawdown_pct: numOrNull(m.max_drawdown_pct ?? row?.max_drawdown_pct),
    total_return_pct: numOrNull(m.total_return_pct ?? row?.total_return_pct),
    profit_factor: numOrNull(m.profit_factor ?? row?.profit_factor),
    best_multiple: numOrNull(m.best_multiple ?? row?.best_multiple),
    robust: row?.robust === true || m.robust === true,
    modeled: row?.modeled === true || m.modeled === true,
    preferred: botId != null && (FOX_RANK_PREFERRED_BOTS as readonly number[]).includes(botId),
  };
}

export function compareBacktestRank(a: BacktestRankRow, b: BacktestRankRow): number {
  const pa = preferredIndex(a.bot_id);
  const pb = preferredIndex(b.bot_id);
  if (pa !== pb) return pa - pb;
  if (a.robust !== b.robust) return a.robust ? -1 : 1;
  const exp = (b.expectancy_pct ?? -Infinity) - (a.expectancy_pct ?? -Infinity);
  if (exp !== 0) return exp;
  return (b.trades || 0) - (a.trades || 0);
}

export function foxBacktestRank(rows: any[] | null | undefined): FoxBacktestRank {
  const rank = (rows || []).map(mapBacktestRankRow).sort(compareBacktestRank);
  return {
    shape: FOX_BACKTEST_RANK_SHAPE,
    preferred_bot_ids: [...FOX_RANK_PREFERRED_BOTS],
    preferred_note: PREFERRED_NOTE,
    rank,
  };
}
