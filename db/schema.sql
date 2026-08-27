-- rh.tradingbot — MAMP MySQL schema
-- Stores everything: account snapshots, positions, orders, bots, signals,
-- risk decisions, approvals, research, news, chat, RAG index, learnings, audit.
-- Idempotent: safe to re-run (CREATE TABLE IF NOT EXISTS).

CREATE DATABASE IF NOT EXISTS rh_tradingbot
  CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
USE rh_tradingbot;

-- Key/value config: global mode, kill switch, risk limits overrides, etc.
CREATE TABLE IF NOT EXISTS settings (
  `key`       VARCHAR(128) PRIMARY KEY,
  `value`     JSON NOT NULL,
  updated_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB;

-- OAuth token store for the Robinhood MCP connection (backend = MCP client).
CREATE TABLE IF NOT EXISTS oauth_tokens (
  provider      VARCHAR(64) PRIMARY KEY,        -- 'robinhood'
  access_token  TEXT,
  refresh_token TEXT,
  expires_at    BIGINT,                         -- epoch ms
  raw           JSON,
  updated_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB;

-- Account snapshots (the funded agentic/bot account).
CREATE TABLE IF NOT EXISTS accounts (
  account_number VARCHAR(64) PRIMARY KEY,
  env            VARCHAR(24),                            -- alpaca_paper|robinhood_live
  type           VARCHAR(64),
  buying_power   DECIMAL(18,2),
  cash           DECIMAL(18,2),
  equity         DECIMAL(18,2),
  raw            JSON,
  updated_at     TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB;

-- Current positions (refreshed from MCP).
CREATE TABLE IF NOT EXISTS positions (
  id             BIGINT AUTO_INCREMENT PRIMARY KEY,
  account_number VARCHAR(64),
  env            VARCHAR(24),                            -- alpaca_paper|robinhood_live
  symbol         VARCHAR(32) NOT NULL,                   -- underlying ticker (display)
  occ_symbol     VARCHAR(40) NOT NULL DEFAULT '',        -- '' for shares; OCC contract for options
  asset_class    VARCHAR(16) NOT NULL DEFAULT 'equity',  -- equity|etf|option (never crypto)
  qty            DECIMAL(18,6),
  avg_cost       DECIMAL(18,4),
  market_value   DECIMAL(18,2),
  unrealized_pl  DECIMAL(18,2),
  raw            JSON,
  updated_at     TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  -- Keyed by the concrete contract: option contracts on one underlying (and an
  -- equity + options on the same ticker) no longer collide.
  UNIQUE KEY uq_pos (account_number, env, symbol, occ_symbol)
) ENGINE=InnoDB;

-- Orders / trades — full lifecycle and audit.
CREATE TABLE IF NOT EXISTS orders (
  id            BIGINT AUTO_INCREMENT PRIMARY KEY,
  rh_order_id   VARCHAR(96) UNIQUE,             -- null until placed (or never, in observe)
  env           VARCHAR(24),                    -- alpaca_paper|robinhood_live
  symbol        VARCHAR(32) NOT NULL,
  asset_class   VARCHAR(16) NOT NULL DEFAULT 'equity',
  side          VARCHAR(8)  NOT NULL,           -- buy|sell
  qty           DECIMAL(18,6) NOT NULL,
  order_type    VARCHAR(16) DEFAULT 'market',   -- market|limit|stop|stop_limit
  limit_price   DECIMAL(18,4),
  stop_price    DECIMAL(18,4),
  status        VARCHAR(24) DEFAULT 'draft',    -- draft|staged|approved|placed|filled|rejected|canceled|vetoed
  filled_qty    DECIMAL(18,6) DEFAULT 0,
  filled_price  DECIMAL(18,4),
  source        VARCHAR(16) DEFAULT 'manual',   -- manual|bot|ai
  bot_id        BIGINT,
  mode          VARCHAR(16),                    -- observe|cautious|auto|full_auto at time of action
  risk_decision VARCHAR(16),                    -- allow|veto
  risk_reason   TEXT,
  rationale     TEXT,                           -- Claude's reasoning when source=ai/bot
  raw           JSON,
  created_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_orders_symbol (symbol),
  INDEX idx_orders_status (status),
  INDEX idx_orders_created (created_at)
) ENGINE=InnoDB;

-- Pending approvals (cautious mode): a staged order awaiting one-click decision.
CREATE TABLE IF NOT EXISTS approvals (
  id          BIGINT AUTO_INCREMENT PRIMARY KEY,
  order_id    BIGINT NOT NULL,
  symbol      VARCHAR(32),
  side        VARCHAR(8),
  qty         DECIMAL(18,6),
  draft       JSON NOT NULL,
  status      VARCHAR(16) DEFAULT 'pending',    -- pending|approved|rejected|expired
  created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  decided_at  TIMESTAMP NULL,
  INDEX idx_appr_status (status)
) ENGINE=InnoDB;

-- Bots: symbol-scoped strategies with per-bot execution mode.
CREATE TABLE IF NOT EXISTS bots (
  id               BIGINT AUTO_INCREMENT PRIMARY KEY,
  name             VARCHAR(128) NOT NULL,
  env              VARCHAR(24) NOT NULL DEFAULT 'alpaca_paper', -- fleet owner: alpaca_paper|robinhood_live
  enabled          TINYINT(1) DEFAULT 0,
  symbols          JSON NOT NULL,               -- ["AAPL","SPY"]
  asset_class      VARCHAR(16) DEFAULT 'equity',
  rules            JSON,                         -- indicator triggers
  ai_gate          JSON,                         -- {enabled, min_conviction}
  action           JSON,                         -- sizing, side, option selection
  risk             JSON,                         -- per-bot overrides of global limits
  mode             VARCHAR(16) DEFAULT 'observe',-- observe|cautious|auto|full_auto
  last_evaluated_at TIMESTAMP NULL,
  last_result      JSON,
  created_at       TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at       TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_bots_env (env),
  UNIQUE KEY uq_bots_env_name (env, name)
) ENGINE=InnoDB;

-- Daily account equity per environment (P/L windows for brokers with no history API).
CREATE TABLE IF NOT EXISTS equity_snapshots (
  id           BIGINT AUTO_INCREMENT PRIMARY KEY,
  env          VARCHAR(24) NOT NULL,
  snap_date    DATE NOT NULL,
  equity       DECIMAL(18,2),
  cash         DECIMAL(18,2),
  buying_power DECIMAL(18,2),
  created_at   TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_equity_snap (env, snap_date),
  INDEX idx_equity_snap_env (env)
) ENGINE=InnoDB;

-- Fired signals (explainability for every bot evaluation).
CREATE TABLE IF NOT EXISTS signals (
  id         BIGINT AUTO_INCREMENT PRIMARY KEY,
  bot_id     BIGINT,
  symbol     VARCHAR(32),
  timeframe  VARCHAR(16),
  fired      TINYINT(1) DEFAULT 0,
  matched    JSON,
  snapshot   JSON,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_sig_symbol (symbol),
  INDEX idx_sig_created (created_at)
) ENGINE=InnoDB;

-- Every risk-engine decision (allow/veto) — full audit trail.
CREATE TABLE IF NOT EXISTS risk_events (
  id         BIGINT AUTO_INCREMENT PRIMARY KEY,
  symbol     VARCHAR(32),
  side       VARCHAR(8),
  qty        DECIMAL(18,6),
  decision   VARCHAR(16),                       -- allow|veto
  reason     TEXT,
  rules      JSON,
  computed   JSON,
  source     VARCHAR(16),
  bot_id     BIGINT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_risk_created (created_at)
) ENGINE=InnoDB;

-- Claude research / sentiment analyses.
CREATE TABLE IF NOT EXISTS research_analyses (
  id               BIGINT AUTO_INCREMENT PRIMARY KEY,
  symbol           VARCHAR(32),
  thesis           TEXT,
  sentiment        DECIMAL(5,3),                -- -1..1
  conviction       DECIMAL(5,3),                -- 0..1
  regime           VARCHAR(32),
  key_risks        JSON,
  suggested_action VARCHAR(32),
  provider         VARCHAR(32) DEFAULT 'anthropic',
  model            VARCHAR(64),
  raw              JSON,
  created_at       TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_research_symbol (symbol),
  INDEX idx_research_created (created_at)
) ENGINE=InnoDB;

-- Market news feed.
CREATE TABLE IF NOT EXISTS news (
  id           BIGINT AUTO_INCREMENT PRIMARY KEY,
  ext_id       VARCHAR(64) UNIQUE,                 -- provider id (dedup)
  symbol       VARCHAR(32),
  headline     TEXT,
  summary      TEXT,
  source       VARCHAR(128),
  url          TEXT,
  sentiment    DECIMAL(5,3),
  published_at TIMESTAMP NULL,
  raw          JSON,
  created_at   TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_news_symbol (symbol),
  INDEX idx_news_published (published_at)
) ENGINE=InnoDB;

-- Optional OHLCV cache for indicators/backtests.
CREATE TABLE IF NOT EXISTS market_bars (
  id        BIGINT AUTO_INCREMENT PRIMARY KEY,
  symbol    VARCHAR(32),
  timeframe VARCHAR(16),
  ts        BIGINT,                             -- epoch ms (bar open)
  o DECIMAL(18,4), h DECIMAL(18,4), l DECIMAL(18,4), c DECIMAL(18,4),
  v BIGINT,
  UNIQUE KEY uq_bar (symbol, timeframe, ts)
) ENGINE=InnoDB;

-- Chat history (text-to-SQL / RAG assistant).
CREATE TABLE IF NOT EXISTS chat_messages (
  id         BIGINT AUTO_INCREMENT PRIMARY KEY,
  role       VARCHAR(16),                        -- user|assistant|system
  content    MEDIUMTEXT,
  meta       JSON,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB;

-- RAG index over trades/research/news/learnings.
CREATE TABLE IF NOT EXISTS rag_documents (
  id           BIGINT AUTO_INCREMENT PRIMARY KEY,
  source_table VARCHAR(64),
  source_id    BIGINT,
  doc_text     MEDIUMTEXT,
  embedding    JSON,                             -- vector as a JSON array of floats
  embed_model  VARCHAR(64),                      -- model that produced it (spaces are incomparable)
  embedded_at  DATETIME,
  metadata     JSON,
  env          VARCHAR(24) NULL,                 -- NULL = shared market knowledge, else the account
  created_at   TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at   TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_rag_src (source_table, source_id),
  INDEX idx_rag_documents_env (env),
  INDEX idx_rag_documents_embed (embed_model),
  FULLTEXT KEY ft_rag (doc_text)
) ENGINE=InnoDB;

-- Learnings: post-trade reviews, lessons, things the bot/Claude should remember.
CREATE TABLE IF NOT EXISTS learnings (
  id         BIGINT AUTO_INCREMENT PRIMARY KEY,
  kind       VARCHAR(32),                        -- post_trade|lesson|note|playbook
  title      VARCHAR(255),
  body       MEDIUMTEXT,
  data       JSON,
  tags       JSON,
  embedding  JSON,                                -- vector as a JSON array of floats
  embed_model VARCHAR(64),
  embedded_at DATETIME,
  env        VARCHAR(24) NULL,                    -- NULL = shared, else the account it was learned on
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_learn_kind (kind),
  INDEX idx_learnings_env (env),
  INDEX idx_learnings_embed (embed_model)
) ENGINE=InnoDB;

-- Growth campaigns: a documented goal (e.g. $1k → $100k) with a milestone ladder,
-- phased strategies, and a day-by-day equity track. One row per campaign.
CREATE TABLE IF NOT EXISTS campaigns (
  id            BIGINT AUTO_INCREMENT PRIMARY KEY,
  name          VARCHAR(160) NOT NULL,
  env           VARCHAR(24)  DEFAULT 'robinhood_live', -- which account this tracks
  status        VARCHAR(16)  DEFAULT 'active',          -- active|paused|done|aborted
  start_equity  DECIMAL(18,2),
  target_equity DECIMAL(18,2),
  start_date    DATE,
  target_date   DATE,
  thesis        MEDIUMTEXT,                             -- macro/supercycle narrative
  milestones    JSON,                                   -- [{level, label, target, ...}]
  phases        JSON,                                   -- [{phase, range, strategy, bots[], rules}]
  rules         JSON,                                   -- risk rules (max risk/trade, daily stop)
  sources       JSON,                                   -- research source URLs
  created_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB;

-- Daily campaign tracking: one snapshot per day of account equity + progress.
CREATE TABLE IF NOT EXISTS campaign_snapshots (
  id           BIGINT AUTO_INCREMENT PRIMARY KEY,
  campaign_id  BIGINT NOT NULL,
  snap_date    DATE NOT NULL,
  equity       DECIMAL(18,2),
  cash         DECIMAL(18,2),
  deposits     DECIMAL(18,2) DEFAULT 0,   -- $ added that day (user contributions)
  pnl_day      DECIMAL(18,2),
  pnl_total    DECIMAL(18,2),
  target_equity_today DECIMAL(18,2),       -- the on-track value for this date
  phase        VARCHAR(48),
  recommendation MEDIUMTEXT,               -- the day's coaching / next action
  note         TEXT,
  created_at   TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_camp_day (campaign_id, snap_date),
  INDEX idx_camp (campaign_id)
) ENGINE=InnoDB;

-- Alerts: actionable signals surfaced to the user. Groq triages news fast/cheap
-- on a passive cycle; if it flags something tradeable it's escalated to Kimi for a
-- deeper take, which writes a 'trade' alert linked to the relevant bots.
CREATE TABLE IF NOT EXISTS alerts (
  id          BIGINT AUTO_INCREMENT PRIMARY KEY,
  level       VARCHAR(16) DEFAULT 'info',     -- info|watch|trade
  source      VARCHAR(24) DEFAULT 'system',   -- groq|kimi|system|backtest
  title       VARCHAR(255) NOT NULL,
  body        MEDIUMTEXT,
  symbol      VARCHAR(32),
  direction   VARCHAR(8),                      -- bullish|bearish|neutral
  urgency     TINYINT DEFAULT 1,              -- 1..5
  bot_ids     JSON,                            -- bots this is actionable for
  news_id     BIGINT,
  status      VARCHAR(16) DEFAULT 'new',      -- new|seen|dismissed
  created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_alerts_status (status),
  INDEX idx_alerts_created (created_at)
) ENGINE=InnoDB;

-- Per-ticker learning "brain": each cycle the AI scores how a ticker is behaving
-- and what it's learning, so the system compounds knowledge over time (Focus mode).
CREATE TABLE IF NOT EXISTS ticker_insights (
  id              BIGINT AUTO_INCREMENT PRIMARY KEY,
  symbol          VARCHAR(32) NOT NULL,
  performance_score DECIMAL(6,2),                 -- 0..100 evolving read of how tradable it is now
  trend           VARCHAR(16),                    -- up|down|chop
  summary         MEDIUMTEXT,                     -- the day's read
  lesson          MEDIUMTEXT,                     -- what to do differently (Kimi, when escalated)
  data            JSON,                           -- stats/signals snapshot the read was based on
  source          VARCHAR(16) DEFAULT 'groq',     -- groq|kimi
  env             VARCHAR(24) NULL,               -- the account whose signals/orders produced the read
  created_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_ti_symbol (symbol),
  INDEX idx_ti_created (created_at),
  INDEX idx_ticker_insights_env (env)
) ENGINE=InnoDB;

-- Audit log for everything notable.
CREATE TABLE IF NOT EXISTS audit_log (
  id         BIGINT AUTO_INCREMENT PRIMARY KEY,
  type       VARCHAR(64),
  message    TEXT,
  data       JSON,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_audit_type (type),
  INDEX idx_audit_created (created_at)
) ENGINE=InnoDB;

-- Watchlist.
CREATE TABLE IF NOT EXISTS watchlist (
  symbol   VARCHAR(32) PRIMARY KEY,
  note     VARCHAR(255),
  added_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB;

-- Backtest results.
CREATE TABLE IF NOT EXISTS backtests (
  id           BIGINT AUTO_INCREMENT PRIMARY KEY,
  bot_id       BIGINT,
  name         VARCHAR(160),
  symbol       VARCHAR(32),
  asset_class  VARCHAR(16),
  days         INT,
  params       JSON,
  metrics      JSON,
  trades       JSON,
  equity_curve JSON,
  created_at   TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_bt_bot (bot_id),
  INDEX idx_bt_created (created_at)
) ENGINE=InnoDB;

-- Research-backed strategy playbooks (2x-10x options ideas).
CREATE TABLE IF NOT EXISTS playbooks (
  id              BIGINT AUTO_INCREMENT PRIMARY KEY,
  symbol          VARCHAR(32),
  title           VARCHAR(200),
  category        VARCHAR(32),
  side            VARCHAR(8),
  option_type     VARCHAR(8),
  horizon         VARCHAR(40),
  target_multiple VARCHAR(32),
  thesis          MEDIUMTEXT,
  setup           JSON,
  stats           JSON,
  risk            TEXT,
  bot_id          BIGINT,
  created_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB;

INSERT INTO watchlist (symbol, note) VALUES
 ('META','Mega-cap, high IV swings'),('TSLA','High-beta day/swing'),
 ('SPY','Index hedge/momentum'),('QQQ','Nasdaq momentum'),
 ('AMD','Semis high-beta'),('MSFT','Mega-cap trend')
ON DUPLICATE KEY UPDATE symbol=symbol;

-- Earnings calendar + transcript highlights (web-researched).
CREATE TABLE IF NOT EXISTS earnings (
  id            BIGINT AUTO_INCREMENT PRIMARY KEY,
  symbol        VARCHAR(32),
  report_date   DATE,
  period_label  VARCHAR(32),
  status        VARCHAR(16),
  confirmed     TINYINT(1) DEFAULT 0,
  eps_estimate  VARCHAR(32),
  eps_actual    VARCHAR(32),
  revenue       VARCHAR(48),
  guidance      TEXT,
  transcript_summary MEDIUMTEXT,
  source        VARCHAR(128),
  source_url    TEXT,
  updated_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_earn (symbol, period_label)
) ENGINE=InnoDB;

-- My own research desk: trend analysis + strategy + catalysts + sources.
CREATE TABLE IF NOT EXISTS research_notes (
  id            BIGINT AUTO_INCREMENT PRIMARY KEY,
  symbol        VARCHAR(32),
  title         VARCHAR(200),
  trend         VARCHAR(16),
  stance        VARCHAR(16),
  horizon       VARCHAR(24),
  analysis      MEDIUMTEXT,
  catalysts     JSON,
  recommended_strategy TEXT,
  stats         JSON,
  sources       JSON,
  author        VARCHAR(48) DEFAULT 'claude-code-research',
  updated_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_note (symbol, title)
) ENGINE=InnoDB;

-- Earnings decks & transcripts library (IR archive URLs + analyzed quarters).
CREATE TABLE IF NOT EXISTS earnings_docs (
  id          BIGINT AUTO_INCREMENT PRIMARY KEY,
  symbol      VARCHAR(32),
  period_label VARCHAR(32),
  doc_type    VARCHAR(16),
  title       VARCHAR(200),
  url         TEXT,
  analyzed    TINYINT(1) DEFAULT 0,
  summary     MEDIUMTEXT,
  key_points  JSON,
  source      VARCHAR(128),
  created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_doc (symbol, period_label, doc_type)
) ENGINE=InnoDB;

-- Learning iterator: one row per account per learning pass (daily after the close, plus a
-- weekly digest). `evidence` is the exact, measured pack the model reasoned over; `review`
-- is what came back plus what was done with it.
CREATE TABLE IF NOT EXISTS learning_runs (
  id           BIGINT AUTO_INCREMENT PRIMARY KEY,
  env          VARCHAR(24) NOT NULL,                    -- alpaca_paper|robinhood_live
  kind         VARCHAR(16) NOT NULL DEFAULT 'daily',    -- daily|weekly
  run_date     DATE NOT NULL,
  status       VARCHAR(16) NOT NULL DEFAULT 'running',  -- running|done|dry_run|error
  evidence     JSON,
  review       JSON,
  ideas_tested INT DEFAULT 0,
  ideas_kept   INT DEFAULT 0,
  model        VARCHAR(80),
  error        TEXT,
  created_at   TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_learning_runs_env (env),
  INDEX idx_learning_runs_day (env, kind, run_date)
) ENGINE=InnoDB;

-- Strategy ideas the iterator generated, with lineage (generation/parent), the rule object
-- in the engine's own vocabulary, the full backtest that judged it, and the DISABLED bot it
-- became when it passed. Losers are marked rejected/retired, never deleted.
CREATE TABLE IF NOT EXISTS strategy_ideas (
  id          BIGINT AUTO_INCREMENT PRIMARY KEY,
  env         VARCHAR(24) NOT NULL,
  run_id      BIGINT NULL,
  generation  INT NOT NULL DEFAULT 1,
  parent_id   BIGINT NULL,
  name        VARCHAR(160) NOT NULL,
  horizon     VARCHAR(16) NOT NULL,                     -- daytrade|swing_daily|swing_weekly
  asset_class VARCHAR(16) NOT NULL,                     -- equity|option
  rule        JSON,
  backtest    JSON,
  status      VARCHAR(16) NOT NULL DEFAULT 'proposed',  -- proposed|kept|rejected|retired
  bot_id      BIGINT NULL,
  live        JSON NULL,
  created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_strategy_ideas_env (env),
  INDEX idx_strategy_ideas_status (env, status),
  INDEX idx_strategy_ideas_run (run_id),
  INDEX idx_strategy_ideas_bot (bot_id)
) ENGINE=InnoDB;

-- Live position monitors: per-bot trailing-stop / take-profit / stop-loss.
CREATE TABLE IF NOT EXISTS position_monitors (
  id            BIGINT AUTO_INCREMENT PRIMARY KEY,
  symbol        VARCHAR(32),
  occ_symbol    VARCHAR(40) DEFAULT '',                 -- OCC contract for option monitors
  env           VARCHAR(24),                            -- alpaca_paper|robinhood_live
  account_number VARCHAR(64),
  asset_class   VARCHAR(16) DEFAULT 'equity',
  qty           DECIMAL(18,6),
  entry_price   DECIMAL(18,4),
  peak_price    DECIMAL(18,4),
  last_price    DECIMAL(18,4),
  tp_pct        DECIMAL(8,2),
  sl_pct        DECIMAL(8,2),
  trail_pct     DECIMAL(8,2),
  bot_id        BIGINT,
  order_id      BIGINT,
  status        VARCHAR(16) DEFAULT 'open',
  reason        VARCHAR(48),
  opened_at     TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  closed_at     TIMESTAMP NULL,
  INDEX idx_mon_status (status)
) ENGINE=InnoDB;

-- Seed defaults.
INSERT INTO settings (`key`, `value`) VALUES
  ('global_mode', JSON_QUOTE('observe')),
  ('kill_switch', CAST('false' AS JSON))
ON DUPLICATE KEY UPDATE `key`=`key`;
