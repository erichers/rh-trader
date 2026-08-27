import mysql from 'mysql2/promise';
import { config, type Mode, type TradingEnv } from './config.js';

export const pool = mysql.createPool({
  host: config.db.host,
  port: config.db.port,
  user: config.db.user,
  password: config.db.password,
  database: config.db.database,
  waitForConnections: true,
  connectionLimit: 8,
  namedPlaceholders: true,
});

export async function q<T = any>(sql: string, params?: any): Promise<T[]> {
  const [rows] = await pool.query(sql, params);
  return rows as T[];
}

export async function exec(sql: string, params?: any): Promise<mysql.ResultSetHeader> {
  const [res] = await pool.query(sql, params);
  return res as mysql.ResultSetHeader;
}

export async function ping(): Promise<boolean> {
  try {
    await pool.query('SELECT 1');
    return true;
  } catch {
    return false;
  }
}

// ── settings helpers ───────────────────────────────────────────────────────
export async function getSetting<T = any>(key: string, fallback: T): Promise<T> {
  const rows = await q<{ value: any }>('SELECT `value` FROM settings WHERE `key`=:key', { key });
  if (!rows.length) return fallback;
  let v: any = rows[0].value;
  // mysql2 returns JSON columns as either parsed values OR raw strings depending on
  // driver/server version. Normalize so consumers (kill switch, mode, env, limits)
  // are correct either way — a string '"true"' must read back as boolean true.
  if (typeof v === 'string') { try { v = JSON.parse(v); } catch { /* leave as string */ } }
  return v as T;
}

export async function setSetting(key: string, value: any): Promise<void> {
  await exec(
    'INSERT INTO settings (`key`,`value`) VALUES (:key, CAST(:value AS JSON)) ' +
      'ON DUPLICATE KEY UPDATE `value`=CAST(:value AS JSON)',
    { key, value: JSON.stringify(value) },
  );
}

export async function getGlobalMode(): Promise<Mode> {
  return (await getSetting<Mode>('global_mode', config.trading.defaultMode)) as Mode;
}

export async function getKillSwitch(): Promise<boolean> {
  return (await getSetting<boolean>('kill_switch', config.trading.killSwitch)) === true;
}

export async function getTradingEnv(): Promise<TradingEnv> {
  return (await getSetting<TradingEnv>('trading_env', config.trading.defaultEnv)) as TradingEnv;
}

export async function setTradingEnv(env: TradingEnv): Promise<void> {
  await setSetting('trading_env', env);
}

// ── Adjustable risk limits (DB override merged over .env defaults) ───────────
export type RiskLimits = {
  maxPositionUsd: number;
  maxConcentrationPct: number;
  maxDailyLossPct: number;
  maxOrdersPerDay: number;
};

/** Effective risk limits = config defaults overridden by any saved UI settings. */
export async function getRiskLimits(): Promise<RiskLimits> {
  const t = config.trading;
  const defaults: RiskLimits = {
    maxPositionUsd: t.maxPositionUsd,
    maxConcentrationPct: t.maxConcentrationPct,
    maxDailyLossPct: t.maxDailyLossPct,
    maxOrdersPerDay: t.maxOrdersPerDay,
  };
  const o = await getSetting<Partial<RiskLimits>>('risk_limits', {});
  const pick = (v: any, d: number) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : d);
  return {
    maxPositionUsd: pick(o?.maxPositionUsd, defaults.maxPositionUsd),
    maxConcentrationPct: pick(o?.maxConcentrationPct, defaults.maxConcentrationPct),
    maxDailyLossPct: pick(o?.maxDailyLossPct, defaults.maxDailyLossPct),
    maxOrdersPerDay: pick(o?.maxOrdersPerDay, defaults.maxOrdersPerDay),
  };
}

export function riskLimitDefaults(): RiskLimits {
  const t = config.trading;
  return { maxPositionUsd: t.maxPositionUsd, maxConcentrationPct: t.maxConcentrationPct, maxDailyLossPct: t.maxDailyLossPct, maxOrdersPerDay: t.maxOrdersPerDay };
}

// ── Trade defaults: how much money goes into ONE trade, and how it exits ─────
/** The global sizing + exit defaults every bot inherits when it does not pin its own.
 *  `amount_usd` is the TARGET notional per trade (shares × price, or contracts × premium
 *  × 100); `min_usd`/`max_usd` bracket what is actually allowed. `take_profit_pct` 0 means
 *  NO cap — the system rule is positive skew (small stop, let winners ride the trail). */
export type TradeDefaults = {
  amount_usd: number | null;
  min_usd: number;
  max_usd: number;
  take_profit_pct: number;
  stop_loss_pct: number;
  trailing_stop_pct: number;
};

/** Factory baseline (no saved settings): sizing is OPT-IN (amount_usd unset until someone
 *  chooses one, so bots keep placing their own lot sizes), min/max/exits derive from the
 *  position cap already in force (.env MAX_POSITION_USD, or whatever the risk limits were
 *  adjusted to), exits from the asymmetric profile the monitor uses for unmanaged options. */
export async function tradeDefaultsFactory(): Promise<TradeDefaults> {
  const max = (await getRiskLimits()).maxPositionUsd;
  return {
    amount_usd: null,
    min_usd: Math.max(25, Math.round(max * 0.05)),
    max_usd: max,
    take_profit_pct: 0,   // no cap — ride the trailing stop
    stop_loss_pct: 35,
    trailing_stop_pct: 40,
  };
}

/** Effective trade defaults = factory baseline overridden by anything saved from the UI. */
export async function getTradeDefaults(): Promise<TradeDefaults> {
  const base = await tradeDefaultsFactory();
  const o = await getSetting<Partial<TradeDefaults>>('trade_defaults', {});
  return clampTradeDefaults(o || {}, base);
}

/** Clamp a (possibly partial, possibly garbage) trade-defaults object onto a base.
 *  Money fields must be positive and ordered min <= amount <= max; percentages are either
 *  0 (feature off) or a sane 1-95 (a 0.2% stop would round-trip every trade instantly). */
export function clampTradeDefaults(next: Partial<TradeDefaults>, base: TradeDefaults): TradeDefaults {
  const money = (v: any, prev: number) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Math.min(1_000_000_000, Math.max(25, Number(v))) : prev);
  // Only an explicit 0 turns a percentage off; anything unparseable or negative keeps
  // the current value rather than silently disabling an exit.
  const pct = (v: any, prev: number, hi: number) => {
    if (v == null || v === '' || !Number.isFinite(Number(v))) return prev;
    const n = Number(v);
    if (n < 0) return prev;
    return n === 0 ? 0 : Math.min(hi, Math.max(1, n));
  };
  // amount_usd is opt-in: an explicit null/'' clears it (sizing skipped, bots keep their own
  // lot sizes); anything else falls back to money()'s usual "keep the previous value" rule.
  const rawAmount: any = next.amount_usd;
  const amount = rawAmount === null || rawAmount === ''
    ? null
    : rawAmount === undefined
      ? base.amount_usd
      : money(rawAmount, base.amount_usd ?? 25);
  let min = money(next.min_usd, base.min_usd);
  let max = money(next.max_usd, base.max_usd);
  if (amount != null) {
    if (min > amount) min = amount;    // a minimum above the target would veto every trade
    if (max < amount) max = amount;    // a maximum below the target would veto every trade
  }
  const tp = pct(next.take_profit_pct, base.take_profit_pct, 500);
  let sl = pct(next.stop_loss_pct, base.stop_loss_pct, 95);
  const trail = pct(next.trailing_stop_pct, base.trailing_stop_pct, 95);
  // A default of "no stop AND no trailing stop" would leave every inheriting bot's position
  // unmanaged, so the global set always keeps at least one exit. One of them may be 0.
  if (!sl && !trail) sl = base.stop_loss_pct || 35;
  return { amount_usd: amount, min_usd: min, max_usd: max, take_profit_pct: tp, stop_loss_pct: sl, trailing_stop_pct: trail };
}

/** Save the global trade defaults (clamped). Returns the new effective values. */
export async function setTradeDefaults(next: Partial<TradeDefaults>): Promise<TradeDefaults> {
  const cur = await getTradeDefaults();
  const merged = clampTradeDefaults({ ...cur, ...(next || {}) }, cur); // invalid input keeps the current value
  await setSetting('trade_defaults', merged);
  await audit('trade.defaults.set', 'trade sizing/exit defaults updated', merged);
  return getTradeDefaults();
}

/** Global default position-holding policy. By DEFAULT nothing is held overnight or over
 *  weekends (flatten before each session close) — a leveraged-options safety stance. A bot
 *  can override via risk.hold_overnight / risk.hold_over_weekend. `closeBufferMin` is how
 *  many minutes before the close the flatten kicks in. */
export type ExitPolicy = { holdOvernight: boolean; holdOverWeekend: boolean; closeBufferMin: number };
export async function getExitPolicy(): Promise<ExitPolicy> {
  const o = await getSetting<Partial<ExitPolicy>>('exit_policy', {});
  return {
    holdOvernight: o?.holdOvernight === true,           // default false → flatten at EOD
    holdOverWeekend: o?.holdOverWeekend === true,       // default false → flatten before weekends
    closeBufferMin: Number.isFinite(Number(o?.closeBufferMin)) && Number(o?.closeBufferMin) > 0 ? Math.min(60, Math.max(2, Number(o?.closeBufferMin))) : 15,
  };
}
export async function setExitPolicy(next: Partial<ExitPolicy>): Promise<ExitPolicy> {
  const cur = await getSetting<Partial<ExitPolicy>>('exit_policy', {});
  const merged = { ...cur, ...next };
  await setSetting('exit_policy', merged);
  await audit('exit.policy.set', 'overnight/weekend hold policy updated', merged);
  return getExitPolicy();
}

/** Save risk-limit overrides (clamped to sane ranges). Returns the new effective limits. */
export async function setRiskLimits(next: Partial<RiskLimits>): Promise<RiskLimits> {
  const cur = await getSetting<Partial<RiskLimits>>('risk_limits', {});
  const clamp = (v: any, lo: number, hi: number, prev: any) =>
    Number.isFinite(Number(v)) ? Math.min(hi, Math.max(lo, Number(v))) : prev;
  const merged: Partial<RiskLimits> = {
    maxPositionUsd: clamp(next.maxPositionUsd, 50, 1_000_000_000, cur.maxPositionUsd),
    // Concentration up to 95% (you can go heavy on one ticker in Focus) — but never
    // a literal 100% that removes the cap entirely.
    maxConcentrationPct: clamp(next.maxConcentrationPct, 1, 95, cur.maxConcentrationPct),
    // Daily-loss is a SAFETY breaker — capped at 50% so it always trips before the
    // account is half gone (a value of 100 would silently disable it).
    maxDailyLossPct: clamp(next.maxDailyLossPct, 1, 50, cur.maxDailyLossPct),
    maxOrdersPerDay: clamp(next.maxOrdersPerDay, 1, 1000, cur.maxOrdersPerDay),
  };
  await setSetting('risk_limits', merged);
  await audit('risk.limits.set', 'risk limits updated', merged);
  return getRiskLimits();
}

/** Idempotent schema migrations that CREATE TABLE IF NOT EXISTS can't apply to
 *  pre-existing tables. Adds the `env` column used to scope account/position/order
 *  data to the active trading environment (paper ↔ live). */
export async function migrate(): Promise<void> {
  for (const table of ['accounts', 'positions', 'orders', 'position_monitors']) {
    const [col] = await q<{ n: number }>(
      `SELECT COUNT(*) n FROM information_schema.columns
       WHERE table_schema=DATABASE() AND table_name=:t AND column_name='env'`,
      { t: table },
    );
    if (!Number(col?.n)) {
      await exec(`ALTER TABLE ${table} ADD COLUMN env VARCHAR(24) NULL`).catch(() => {});
    }
    // Ensure the env index exists independent of the column check (handles the
    // fresh-schema install path where the column ships but the index doesn't).
    const [idx] = await q<{ n: number }>(
      `SELECT COUNT(*) n FROM information_schema.statistics
       WHERE table_schema=DATABASE() AND table_name=:t AND index_name=:i`,
      { t: table, i: `idx_${table}_env` },
    );
    if (!Number(idx?.n)) await exec(`ALTER TABLE ${table} ADD INDEX idx_${table}_env (env)`).catch(() => {});
  }

  // bots: ACCOUNT scoping. A bot belongs to exactly one trading environment (one fleet
  // per account) — every pre-existing bot is the Alpaca paper fleet. NOT NULL + default
  // so no insert path can ever create an unscoped bot.
  const [botsEnv] = await q<{ n: number }>(
    `SELECT COUNT(*) n FROM information_schema.columns
     WHERE table_schema=DATABASE() AND table_name='bots' AND column_name='env'`,
  );
  if (!Number(botsEnv?.n)) {
    await exec("ALTER TABLE bots ADD COLUMN env VARCHAR(24) NOT NULL DEFAULT 'alpaca_paper' AFTER name")
      .catch((e) => console.error('migrate bots.env:', e?.message));
  }
  const [botsIdx] = await q<{ n: number }>(
    `SELECT COUNT(*) n FROM information_schema.statistics
     WHERE table_schema=DATABASE() AND table_name='bots' AND index_name='idx_bots_env'`,
  );
  if (!Number(botsIdx?.n)) await exec('ALTER TABLE bots ADD INDEX idx_bots_env (env)').catch(() => {});
  // One bot name per account: the DB-level stop against duplicate fleets from a concurrent
  // seed (env switch + worker safety net). Logged, not silent, if it cannot be added. (CP2 gate)
  const [botsUq] = await q<{ n: number }>(
    `SELECT COUNT(*) n FROM information_schema.statistics
     WHERE table_schema=DATABASE() AND table_name='bots' AND index_name='uq_bots_env_name'`,
  );
  if (!Number(botsUq?.n)) await exec('ALTER TABLE bots ADD UNIQUE KEY uq_bots_env_name (env, name)').catch((e) => console.error('migrate uq_bots_env_name:', e?.message));

  // equity_snapshots: one row per environment per day, written by the worker after each
  // broker sync. Brokers without an equity-history API (Robinhood) get their P/L windows
  // from these rows — real recorded account values, never modeled ones.
  await exec(`CREATE TABLE IF NOT EXISTS equity_snapshots (
    id BIGINT AUTO_INCREMENT PRIMARY KEY, env VARCHAR(24) NOT NULL, snap_date DATE NOT NULL,
    equity DECIMAL(18,2), cash DECIMAL(18,2), buying_power DECIMAL(18,2),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uq_equity_snap (env, snap_date), INDEX idx_equity_snap_env (env)
  ) ENGINE=InnoDB`).catch(() => {});

  // Ensure feature tables exist (npm start doesn't re-run schema.sql).
  await exec(`CREATE TABLE IF NOT EXISTS campaigns (
    id BIGINT AUTO_INCREMENT PRIMARY KEY, name VARCHAR(160) NOT NULL,
    env VARCHAR(24) DEFAULT 'robinhood_live', status VARCHAR(16) DEFAULT 'active',
    start_equity DECIMAL(18,2), target_equity DECIMAL(18,2), start_date DATE, target_date DATE,
    thesis MEDIUMTEXT, milestones JSON, phases JSON, rules JSON, sources JSON,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
  ) ENGINE=InnoDB`).catch(() => {});
  await exec(`CREATE TABLE IF NOT EXISTS campaign_snapshots (
    id BIGINT AUTO_INCREMENT PRIMARY KEY, campaign_id BIGINT NOT NULL, snap_date DATE NOT NULL,
    equity DECIMAL(18,2), cash DECIMAL(18,2), deposits DECIMAL(18,2) DEFAULT 0,
    pnl_day DECIMAL(18,2), pnl_total DECIMAL(18,2), target_equity_today DECIMAL(18,2),
    phase VARCHAR(48), recommendation MEDIUMTEXT, note TEXT, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uq_camp_day (campaign_id, snap_date), INDEX idx_camp (campaign_id)
  ) ENGINE=InnoDB`).catch(() => {});
  await exec(`CREATE TABLE IF NOT EXISTS alerts (
    id BIGINT AUTO_INCREMENT PRIMARY KEY, level VARCHAR(16) DEFAULT 'info', source VARCHAR(24) DEFAULT 'system',
    title VARCHAR(255) NOT NULL, body MEDIUMTEXT, symbol VARCHAR(32), direction VARCHAR(8), urgency TINYINT DEFAULT 1,
    bot_ids JSON, news_id BIGINT, status VARCHAR(16) DEFAULT 'new', created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_alerts_status (status), INDEX idx_alerts_created (created_at)
  ) ENGINE=InnoDB`).catch(() => {});
  await exec(`CREATE TABLE IF NOT EXISTS ticker_insights (
    id BIGINT AUTO_INCREMENT PRIMARY KEY, symbol VARCHAR(32) NOT NULL, performance_score DECIMAL(6,2),
    trend VARCHAR(16), summary MEDIUMTEXT, lesson MEDIUMTEXT, data JSON, source VARCHAR(16) DEFAULT 'groq',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, INDEX idx_ti_symbol (symbol), INDEX idx_ti_created (created_at)
  ) ENGINE=InnoDB`).catch(() => {});

  // positions: add occ_symbol (contract identity) and re-key the unique constraint
  // to (account_number, env, symbol, occ_symbol) so option contracts don't collide.
  const [occCol] = await q<{ n: number }>(
    `SELECT COUNT(*) n FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name='positions' AND column_name='occ_symbol'`,
  );
  if (!Number(occCol?.n)) {
    await exec(`ALTER TABLE positions ADD COLUMN occ_symbol VARCHAR(40) NOT NULL DEFAULT '' AFTER symbol`).catch((e) => console.error('migrate occ_symbol:', e?.message));
    await exec('ALTER TABLE positions DROP INDEX uq_pos').catch(() => {});
    await exec('ALTER TABLE positions ADD UNIQUE KEY uq_pos (account_number, env, symbol, occ_symbol)').catch((e) => console.error('migrate uq_pos:', e?.message));
  }

  // position_monitors: occ_symbol so option monitors track the concrete contract.
  const [monOcc] = await q<{ n: number }>(
    `SELECT COUNT(*) n FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name='position_monitors' AND column_name='occ_symbol'`,
  );
  if (!Number(monOcc?.n)) await exec(`ALTER TABLE position_monitors ADD COLUMN occ_symbol VARCHAR(40) DEFAULT '' AFTER symbol`).catch((e) => console.error('migrate mon occ_symbol:', e?.message));

  // position_monitors: exit_price (the ACTUAL exit fill, when the broker reports one) so the
  // journal + performance read a real fill instead of the trigger price. And widen `reason`
  // (was 48 — too small for "EXIT FAILED (...)" diagnostics, which were being truncated).
  const [monFill] = await q<{ n: number }>(
    "SELECT COUNT(*) n FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name='position_monitors' AND column_name='exit_is_fill'",
  );
  if (!Number(monFill?.n)) await exec(`ALTER TABLE position_monitors ADD COLUMN exit_is_fill TINYINT(1) NULL AFTER exit_price`).catch((e) => console.error('migrate mon exit_is_fill:', e?.message));

  const [monExit] = await q<{ n: number }>(
    `SELECT COUNT(*) n FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name='position_monitors' AND column_name='exit_price'`,
  );
  if (!Number(monExit?.n)) await exec(`ALTER TABLE position_monitors ADD COLUMN exit_price DECIMAL(18,4) NULL AFTER last_price`).catch((e) => console.error('migrate mon exit_price:', e?.message));
  await exec(`ALTER TABLE position_monitors MODIFY reason VARCHAR(255) NULL`).catch(() => {});

  // position_monitors: trough_price (max adverse excursion). peak tells us how far winners ran;
  // trough tells us how far trades dipped first — the raw data for tuning stops empirically.
  const [monTrough] = await q<{ n: number }>(
    `SELECT COUNT(*) n FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name='position_monitors' AND column_name='trough_price'`,
  );
  if (!Number(monTrough?.n)) await exec(`ALTER TABLE position_monitors ADD COLUMN trough_price DECIMAL(18,4) NULL AFTER peak_price`).catch((e) => console.error('migrate mon trough_price:', e?.message));

  // journal_meta: user tags / note / reviewed flag keyed to a closed monitor (the journal
  // itself is derived live from position_monitors — this only holds the human annotations).
  await exec(`CREATE TABLE IF NOT EXISTS journal_meta (
    monitor_id BIGINT PRIMARY KEY, tags JSON, note TEXT, reviewed TINYINT DEFAULT 0,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
  ) ENGINE=InnoDB`).catch(() => {});

  // Learning corpus: ACCOUNT scoping + embeddings. env NULL = shared market knowledge
  // (news, research, macro); anything derived from THIS account's trades, signals, orders
  // or bots carries the env it came from, so one account never learns another's history.
  for (const table of ['learnings', 'ticker_insights', 'rag_documents']) {
    await addColumn(table, 'env', 'VARCHAR(24) NULL');
    await ensureIndex(table, `idx_${table}_env`, 'env');
  }
  // One-time backfill, gated on a settings flag (NOT on "column just added", which a
  // failed ALTER or a partial run could miss): every row that predates env tagging came
  // from the Alpaca paper account. Logged, never swallowed. After this point env NULL
  // means "shared market knowledge" by design and must not be rewritten. (CP3 gate)
  if (!(await getSetting<boolean>('migrate:env_backfill_done', false))) {
    let ok = true;
    for (const table of ['learnings', 'ticker_insights', 'rag_documents']) {
      try {
        const r = await exec(`UPDATE ${table} SET env='alpaca_paper' WHERE env IS NULL`);
        if (r.affectedRows) console.log(`[migrate] env backfill: ${table} ${r.affectedRows} row(s) -> alpaca_paper`);
      } catch (e: any) { ok = false; console.error(`migrate env backfill ${table}:`, e?.message); }
    }
    if (ok) await setSetting('migrate:env_backfill_done', true);
  }

  // Embedding columns for the two corpora that get vectorized. embed_model is stored per
  // row because vector spaces from different models are incomparable: a row whose model
  // is not the current one is re-embedded rather than compared.
  for (const table of ['rag_documents', 'learnings']) {
    await addColumn(table, 'embedding', 'JSON NULL');
    await addColumn(table, 'embed_model', 'VARCHAR(64) NULL');
    await addColumn(table, 'embedded_at', 'DATETIME NULL');
    await ensureIndex(table, `idx_${table}_embed`, 'embed_model');
  }
  // rag_documents shipped `embedding LONGTEXT`; promote it to a real JSON column while
  // there is nothing to convert, so vectors read back as arrays instead of strings.
  const [ragEmb] = await q<{ t: string }>(
    `SELECT data_type t FROM information_schema.columns
     WHERE table_schema=DATABASE() AND table_name='rag_documents' AND column_name='embedding'`,
  );
  if (ragEmb && String(ragEmb.t).toLowerCase() !== 'json') {
    const [nonNull] = await q<{ n: number }>('SELECT COUNT(*) n FROM rag_documents WHERE embedding IS NOT NULL');
    if (!Number(nonNull?.n)) await exec('ALTER TABLE rag_documents MODIFY embedding JSON NULL').catch((e) => console.error('migrate rag embedding:', e?.message));
  }

  // Learning iterator: one row per account per learning pass, and every strategy idea it
  // produced. Both are ACCOUNT-scoped (an idea learned on paper is not a live-account idea).
  // run_date is deliberately NOT unique: a forced re-run is a second, separate record.
  await exec(`CREATE TABLE IF NOT EXISTS learning_runs (
    id BIGINT AUTO_INCREMENT PRIMARY KEY, env VARCHAR(24) NOT NULL,
    kind VARCHAR(16) NOT NULL DEFAULT 'daily',            -- daily|weekly
    run_date DATE NOT NULL,
    status VARCHAR(16) NOT NULL DEFAULT 'running',        -- running|done|dry_run|error
    evidence JSON, review JSON,
    ideas_tested INT DEFAULT 0, ideas_kept INT DEFAULT 0,
    model VARCHAR(80), error TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_learning_runs_env (env), INDEX idx_learning_runs_day (env, kind, run_date)
  ) ENGINE=InnoDB`).catch((e) => console.error('migrate learning_runs:', e?.message));
  await exec(`CREATE TABLE IF NOT EXISTS strategy_ideas (
    id BIGINT AUTO_INCREMENT PRIMARY KEY, env VARCHAR(24) NOT NULL, run_id BIGINT NULL,
    generation INT NOT NULL DEFAULT 1, parent_id BIGINT NULL,
    name VARCHAR(160) NOT NULL,
    horizon VARCHAR(16) NOT NULL,                          -- daytrade|swing_daily|swing_weekly
    asset_class VARCHAR(16) NOT NULL,                      -- equity|option
    rule JSON, backtest JSON,
    status VARCHAR(16) NOT NULL DEFAULT 'proposed',        -- proposed|kept|rejected|retired
    bot_id BIGINT NULL, live JSON NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    INDEX idx_strategy_ideas_env (env), INDEX idx_strategy_ideas_status (env, status),
    INDEX idx_strategy_ideas_run (run_id), INDEX idx_strategy_ideas_bot (bot_id)
  ) ENGINE=InnoDB`).catch((e) => console.error('migrate strategy_ideas:', e?.message));

  // FULLTEXT indexes powering the RAG/knowledge search (idempotent).
  await ensureFulltext('news', 'ft_news', 'headline, summary');
  await ensureFulltext('research_notes', 'ft_research', 'analysis');
  await ensureFulltext('learnings', 'ft_learnings', 'title, body');
  await ensureFulltext('ticker_insights', 'ft_insights', 'summary, lesson');
  await ensureFulltext('rag_documents', 'ft_rag', 'doc_text');
}

/** True when `table.column` already exists (information_schema, no DDL side effects). */
async function hasColumn(table: string, column: string): Promise<boolean> {
  const [c] = await q<{ n: number }>(
    `SELECT COUNT(*) n FROM information_schema.columns
     WHERE table_schema=DATABASE() AND table_name=:t AND column_name=:c`,
    { t: table, c: column },
  );
  return !!Number(c?.n);
}

/** Add a column if it is missing. Returns true when it was actually added (so a caller
 *  can run a one-time backfill on exactly the migration run that created it). */
async function addColumn(table: string, column: string, ddl: string): Promise<boolean> {
  if (await hasColumn(table, column)) return false;
  const res = await exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`)
    .then(() => true)
    .catch((e) => { console.error(`migrate ${table}.${column}:`, e?.message); return false; });
  return res;
}

async function ensureIndex(table: string, indexName: string, cols: string): Promise<void> {
  const [idx] = await q<{ n: number }>(
    `SELECT COUNT(*) n FROM information_schema.statistics
     WHERE table_schema=DATABASE() AND table_name=:t AND index_name=:i`,
    { t: table, i: indexName },
  );
  if (!Number(idx?.n)) await exec(`ALTER TABLE ${table} ADD INDEX ${indexName} (${cols})`).catch(() => {});
}

async function ensureFulltext(table: string, indexName: string, cols: string): Promise<void> {
  const [idx] = await q<{ n: number }>(
    `SELECT COUNT(*) n FROM information_schema.statistics
     WHERE table_schema=DATABASE() AND table_name=:t AND index_name=:i`,
    { t: table, i: indexName },
  );
  if (!Number(idx?.n)) await exec(`ALTER TABLE ${table} ADD FULLTEXT INDEX ${indexName} (${cols})`).catch(() => {});
}

export async function audit(type: string, message: string, data?: any): Promise<void> {
  await exec(
    'INSERT INTO audit_log (type, message, data) VALUES (:type, :message, CAST(:data AS JSON))',
    { type, message, data: JSON.stringify(data ?? {}) },
  );
}
