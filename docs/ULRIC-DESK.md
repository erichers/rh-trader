# Ulric desk briefing — rh-trader architecture, inventory, and non-momentum bots

**Audience:** Ulric (VP) and Eric (author). Paper, build-in-public desk.  
**Constraint:** no live trades from this work; do not weaken safety defaults.  
**Stub shipped:** `Residual Reversion vs SPY (proposal stub)` — seeded **disabled** and **observe**. See §6.1.

This note maps the repo as it exists on `main` (initial public release) plus the observe-only stub in this PR. Paths are repo-relative.

---

## 1. Architecture map

The process is a single Node 22 Fastify server that binds **loopback only** (`127.0.0.1:8011`), serves the built React SPA, and owns every order intent. Nothing reaches a broker except through `execute.ts`.

```
browser (React 18 + Vite → frontend/dist)
        │
        ▼
backend/src/index.ts          Fastify + /ws + static SPA + migrate()
        │
        ├─ routes/api.ts        REST surface (health, env, bots, orders, AI, …)
        ├─ worker.ts            market-hours loops (sync / eval / monitors / learn)
        ├─ bots/engine.ts       rule eval → signal row → size → executeDraft
        ├─ bots/strategies.ts   18-template library (+ 1 proposal stub)
        ├─ quickbot.ts          24-candidate short-DTE option catalog
        ├─ execute.ts           THE chokepoint
        ├─ risk/engine.ts       deterministic allow/veto
        ├─ brokers/index.ts     Alpaca paper  |  Robinhood MCP live
        └─ ai/{models,llm,claude,advisor}.ts   task router (propose, never dispose)
        │
        ▼
MySQL  rh_tradingbot   ←  Alpaca (paper + all market data)  ←  Robinhood agentic MCP
```

### 1.1 Backend Fastify entrypoints

| Entry | File | Role |
| --- | --- | --- |
| Process boot | `backend/src/index.ts` | `migrate()`, register routes, `/ws` status (5s shared timer), static `frontend/dist`, Robinhood OAuth callback, `startWorker()` |
| HTTP + WS | `backend/src/routes/api.ts` | Every `/api/*` route. Notable: `GET /api/health`, `POST /api/env` (live switch needs `confirm:true`), `POST /api/kill`, `POST /api/mode`, `POST /api/orders`, bot CRUD + evaluate, QuickBot leaderboard, learning, `POST /api/agent`, `POST /api/chat` |
| Scheduler | `backend/src/worker.ts` | Self-scheduling loops with a re-entrancy guard (a slow tick cannot overlap the next) |

**Worker cadence** (`backend/src/worker.ts`):

| Loop | Period | Gate | What it does |
| --- | --- | --- | --- |
| `sync` | 30s | broker ready | `syncAll()` + equity snapshot + `ensureFleet()` |
| `bots` | 120s | **kill switch off** AND US market open | `evaluateAllEnabledBots()` |
| `monitor` | 45s | always (reconcile-only when closed) | TP / SL / trail / flatten — **does not skip on kill** |
| `alerts` | 60s | 24/7 | fills, failed exits, drawdown |
| `news` | 10 min | — | Alpaca news → `news` |
| `newsAi` | 2h | LLM configured | triage → optional research escalate |
| `review` | 24h | LLM configured | daily coaching |
| `focus` | 40 min | focus on + market open | ticker learn |
| `learning` | 10 min | after close / Sunday | iterator (at most one pass / account / day) |
| `embed` | 10 min | NVIDIA key | RAG embeddings |
| `models` | 6h | — | probe provider `/models` |
| `campaign` | 1h | active campaign | snapshot + coaching |

Market hours come from Alpaca’s clock (`backend/src/market/clock.ts`), with a 9:30–16:00 ET weekday fallback if Alpaca is down.

### 1.2 Frontend surfaces

`frontend/src/App.tsx` is a `HashRouter` SPA. The chrome holds global **mode**, **kill switch**, **paper/live env** (live needs a second confirm), Robinhood connect/sync, and Focus.

| Nav group | Route | View file |
| --- | --- | --- |
| Home | `/` `/focus` `/campaign` | `Dashboard.tsx` `Focus.tsx` `Campaign.tsx` |
| Portfolio | `/positions` `/portfolio` `/orders` `/journal` | `Positions.tsx` `Portfolio.tsx` `Orders.tsx` `Journal.tsx` |
| Markets | `/charts` `/options` | `Charts.tsx` `Options.tsx` |
| Strategy | `/quickbots` `/quant` `/learning` `/bots` `/strategies` `/playbooks` `/backtest` | `QuickBots.tsx` `QuantLab.tsx` `Learning.tsx` `Bots.tsx` `Strategies.tsx` `Playbooks.tsx` `Backtest.tsx` |
| Intel | `/watchlist` `/research` `/news` `/alerts` `/chat` | matching views |
| System | `/activity` `/settings` | `Activity.tsx` `Settings.tsx` |

Bot create/edit: `frontend/src/components/BotWizard.tsx` (six simplified presets — a **subset** of the backend library; default create is `mode: 'observe'`, `enabled: false`). API client: `frontend/src/api/client.ts`. Optional Tauri wrapper: `app-native/`.

### 1.3 MySQL tables that matter for bots / signals / orders / risk

Schema: `db/schema.sql` (idempotent, ~30 tables). Boot `migrate()` in `backend/src/db.ts` adds missing columns/indexes.

| Table | Why it matters |
| --- | --- |
| `settings` | `global_mode`, `kill_switch`, risk-limit overrides, trade defaults, day-start equity keys |
| `bots` | One row per strategy per **account** (`env`). `enabled`, `symbols`, `rules`, `ai_gate`, `action`, `risk`, `mode` |
| `signals` | Every eval: fired + per-condition `checks` + indicator snapshot |
| `orders` | Full lifecycle: `draft \| staged \| placed \| filled \| vetoed \| …`. `source` = `manual \| bot \| ai`. `mode` and `risk_decision` frozen at insert |
| `approvals` | Cautious-mode one-click queue |
| `risk_events` | Every allow/veto with the check map |
| `position_monitors` | Live TP / SL / trail; exit only after a fill |
| `accounts` / `positions` / `equity_snapshots` | Env-scoped book; concentration and daily-loss read these |
| `market_bars` | Alpaca OHLCV cache — indicators, residual, backtest |
| `news` / `alerts` | Headlines + triage/research alerts (`bot_ids` JSON) |
| `research_analyses` / `research_notes` / `earnings` / `earnings_docs` | Research desk + calendar (mostly **seeded**, not a live feed) |
| `learning_runs` / `strategy_ideas` | Iterator evidence + lineage; kept ideas become disabled bots |
| `backtests` / `playbooks` | Workbench + 2x–10x option playbooks |
| `campaigns` / `campaign_snapshots` | $1k→$100k narrative (coaching, not a risk rail) |
| `audit_log` | Boot, env switch, eval, placement |
| `oauth_tokens` | Robinhood OAuth (also `backend/data/oauth-tokens.json`) |
| `rag_documents` / `learnings` / `ticker_insights` / `chat_messages` | Ask AI + focus brain |

**Unique constraint:** `uq_bots_env_name (env, name)` — fleets do not share rows.

### 1.4 How a bot is defined and scheduled

A bot is a JSON document, not a class. Shape (`backend/src/bots/engine.ts` `Bot`):

- `symbols[]`, `asset_class` (`equity \| etf \| option`)
- `rules` — keys the generic `evalRules()` understands (see §2)
- `ai_gate` — `{ enabled, min_conviction }`; optional LLM veto **after** rules fire
- `action` — side, qty, option spec; metadata `_strategy`, `_quickbot`, `_idea`, `_dte`
- `risk` — per-bot caps, exits, `max_entries_per_day` (default 4), `reentry_cooldown_min` (default 45)
- `mode` — `observe \| cautious \| auto \| full_auto`
- `enabled` — 0/1. Worker only selects `enabled=1 AND env=:active`

**Fleet seed** (`backend/src/fleet.ts`): on first switch to an env with zero bots, `seedFleet()` inserts the strategy library (`mode: 'cautious'`) plus QuickBots, all **`enabled=0`**. Reset refuses if the fleet has attributed orders unless `force_orphan`.

**Eval path** (`evaluateBot` → `evaluateAllEnabledBots`):

1. Skip QuickBots to `evaluateQuickbot`.
2. Per symbol: crypto heuristic skip; pull **daily** bars (`refreshBars` / `market_bars`); `snapshot()`; `evalRules()`.
3. If `ai_gate.enabled` and rules fired: `analyzeSymbol()` (`research` task). Fail-closed on LLM error.
4. Insert `signals`. Re-entry gate (count + cooldown, scoped bot+symbol+side+env). In-process lock vs “Run now”.
5. `sizeDraft()` then `executeDraft({ modeOverride: bot.mode })`.
6. Write `last_result`. Focus mode **overrides symbols in memory only** to the focus ticker.

**Important scheduling facts**

- Library templates store `_timeframe: '5m'` on day strategies, but `evaluateBot` **always** fetches `1Day` bars and writes `signals.timeframe = '1d'`. Intraday names are currently daily-bar approximations.
- **Bot `mode` is independent of global mode.** `executeDraft` uses `modeOverride` when present (`bots/engine.ts`, `quickbot.ts`). A bot set to `auto` will place while the chrome says Observe. Global mode applies to manual/`POST /api/orders` and the agent (`POST /api/agent`).
- Kill switch: worker **skips the entire bot loop** (no new signals). Monitors keep running. Risk engine still allows close-only sells.
- Switching env with open monitors **pauses those stops** until you switch back (`POST /api/env` raises a critical alert).

### 1.5 How signals become orders

```
evalRules fired (+ AI gate if any)
    → reentryGate
    → sizeDraft          risk/sizing.ts  (amount vs global/bot defaults, never above the risk ceiling)
    → executeDraft       execute.ts
         ├ resolveDraftContract     (options: Alpaca chain, or RH chain when live)
         ├ decideExecution          riskCheck + mode → observe | stage | execute | veto
         ├ logRiskEvent + INSERT orders
         ├ observe → status draft, no broker
         ├ stage   → approvals row (human approve → executeDraft modeOverride auto)
         └ execute → brokers/index.placeOrder
                      └ createMonitor on bot/AI buys
```

`placeOrder` **re-checks** kill (buys only), crypto, held qty (no short / no naked write), and refuses unpriced option market orders. Env mismatch (`draft.env !== active`) throws before risk.

### 1.6 Observe vs cautious vs auto vs full_auto

Defined in `backend/src/config.ts`. Combined in `decideExecution` (`risk/engine.ts`):

| Mode | If risk allows | Who uses it by default |
| --- | --- | --- |
| `observe` | Log only (`orders.status = draft`) | `.env` `DEFAULT_MODE`; proposal stub; BotWizard default |
| `cautious` | Stage for one-click | Fresh fleet library bots (still **disabled**) |
| `auto` | Place | Human-raised bot mode; monitor exits; approval flush |
| `full_auto` | Place, and **bypass soft sizing caps** (position $, concentration, orders/day). Hard rails + daily-loss **stay** | Agent “open new”; not a seed default |

`full_auto` is the one mode that loosens the sizer. Daily-loss and live-equity fail-closed still bind. Do not use it on a public paper desk until the promotion gate is green.

### 1.7 Alpaca paper vs Robinhood paths

`TradingEnv` is only `alpaca_paper | robinhood_live` (`config.ts`). Comments mention `alpaca_live`; it is **not** wired. `brokerKind()`: anything not `robinhood_live` is Alpaca. `alpacaFor()` **always** returns the paper client.

| Concern | `alpaca_paper` | `robinhood_live` |
| --- | --- | --- |
| Money | Fake | Real, isolated Robinhood **Agentic** account |
| Switch | Default `TRADING_ENV` | `POST /api/env` + `confirm:true` + UI confirm |
| Market data | Alpaca (bars, clock, news, option chains) for **both** envs | same |
| Equity orders | Alpaca REST | MCP `place_equity_order` (`ref_id` idempotency) |
| Options | Alpaca OCC + limit from mid/side | RH instrument id + limit; unresolved → fail-closed |
| Sync | `brokers/index.ts` `syncAll` | `rh/sync.ts` |
| Auth | API key/secret in `.env` | Browser OAuth → `oauth_tokens` + gitignored JSON |

Fleets, orders, monitors, journal, and P/L are **env-scoped**. Connecting Robinhood does not copy paper picks or tuning.

---

## 2. Inventory — every strategy / bot type

Three catalogs plus two generators. **Most of the edge claims are momentum / trend-following.** Mean-reversion exists but is a minority and is thinner (no z-score, no pair, no earnings window) until the stub in this PR.

### 2.1 Strategy library — `backend/src/bots/strategies.ts`

Seeded by `seedStrategies()` as `enabled=0`. Fleet seed uses `mode: 'cautious'` except the proposal stub (forced `observe`).

| key | Name | Style | Params (rules) | Claimed edge | Asset |
| --- | --- | --- | --- | --- | --- |
| `rsi-bounce` | RSI Bounce | **MR in uptrend** | `rsi_below: 32`, `price_above_sma20` | Dip-buy, not a breakdown | equity |
| `ema-crossover` | EMA 9/21 Crossover | **Momentum** | `ema_cross` (event) | Fast EMA crosses slow | equity |
| `macd-momentum` | MACD Momentum | **Momentum + trend** | `macd_positive` (hist cross 0), `price_above_sma20`, `require_all` | Continuation | equity |
| `golden-cross` | Golden Cross | **Trend** | `golden_cross` (SMA50×200 event) | Slow, high-conviction long | equity |
| `bollinger-reversion` | Bollinger Reversion | **Mean reversion** | `bollinger_lower` | Stretch below lower band snaps to mid | equity |
| `donchian-breakout` | Donchian Breakout | **Trend / breakout** | `breakout_high` (prior 20-bar high) | Ride new highs | equity |
| `trend-follow` | Trend Follower | **Trend + momentum** | `price_above_sma20`, `macd_positive`, `require_all` | Stay long while both agree | equity |
| `momentum-day` | Momentum Day Trade | **Momentum** (labeled 5m, eval’d 1d) | `change_above: 1.5`, `macd_positive` | Intraday burst | equity |
| `opening-breakout` | Opening Range Breakout | **Breakout** (same 5m/1d caveat) | `breakout_high` | ORB — **not a true opening range**; Donchian-20 on daily bars | equity |
| `mean-reversion-day` | Intraday Mean Reversion | **MR** (5m/1d caveat) | `rsi_below: 25` | Fade a flush | equity |
| `long-call-momentum` | Long Call — Momentum | **Momentum** | `ema_cross`, `macd_positive` | ATM weekly calls | option |
| `long-call-breakout` | Long Call — Breakout | **Breakout** | `breakout_high` | OTM monthly “lottery” | option |
| `leaps-call` | Long Call — Trend (dated) | **Trend** | `golden_cross` | ITM monthly, slower theta | option |
| `long-put-breakdown` | Long Put — Breakdown | **Trend (bear via long put)** | `breakdown_low`, `death_cross` | Defined-risk short substitute | option |
| `long-put-hedge` | Long Put — Hedge | **MR / overbought fade** | `bollinger_upper`, `rsi_above: 70` | Protective / contrarian | option |
| `long-put-momentum` | Long Put — Down Momentum | **Momentum** | `change_below: -1.5` | Puts on a sharp down day | option |
| `ai-conviction-swing` | AI Conviction Swing | **Trend + LLM gate** | `price_above_sma20` + `min_conviction: 0.65` | Claude must agree | equity |
| `ai-catalyst-call` | AI Catalyst — Long Call | **Momentum + LLM gate** | `ema_cross` + `min_conviction: 0.7` | Catalyst calls | option |
| `residual-reversion-spy` | Residual Reversion vs SPY (proposal stub) | **Stat-arb lite / MR** | `residual_z_below: -2`, `rsi_below: 35`, `price_above_sma20`, `benchmark: SPY`, `require_all` | Name cheap vs SPY, not a chase | equity |

`evalRules` fire logic (`bots/engine.ts`): every **filter** must hold, and ≥ `min_matches` (or all, if `require_all`) **triggers** must hold. Filters alone never fire (`"No trigger rules configured"`). Crossovers are **events**, not states.

**Rule vocabulary already in the engine (not all used by the 18):**  
Triggers: `rsi_below/above`, `rsi_cross_above/below`, `ema_cross`, `macd_positive`, `golden_cross`, `death_cross`, `bollinger_lower/upper`, `breakout_high`, `breakdown_low`, `change_above/below`, `mom5/10_above/below`, `consec_up/down`, **`residual_z_below`**.  
Filters: `price_above/below_sma20`, `above/below_ema50`, `near_high20/low20`, `vol_expand`.

### 2.2 QuickBot catalog — `backend/src/quickbot.ts` `CANDIDATES`

Universe: Mag-7 + SPY + QQQ. DTE bands 1/2/3/4/7. Exits: small SL, **tp=0** (uncapped), ratcheting trail (`risk/exitpolicy.ts`). Backtest: BSM reprice on the real path, 4% round-trip, prefer both-halves-positive. Seeded disabled; `_needs_tuning` until `POST /api/quickbots/seed {force:true}`.

| key | Dir | Style | Rules (abbrev.) | Claimed edge |
| --- | --- | --- | --- | --- |
| `momo_up` | call | **Momentum** | `change_above: 0.8` | Reactive up-day baseline |
| `breakout_up` | call | **Breakout** | `breakout_high` + SMA20 | Trend breakout |
| `rsi_dip` | call | **MR** | `rsi_below: 32` | Oversold bounce |
| `breakdown_dn` | put | **Trend** | `breakdown_low` + below SMA20 | Clean breakdown |
| `rsi_hot` | put | **MR fade** | `rsi_above: 70` | Overbought fade |
| `trend_thrust_call` | call | **Momentum** | +1.2% + SMA20 + EMA50 | Thrust extends 2–3d |
| `five_day_momo_call` | call | **Momentum** | mom5>4, SMA20, near 20d high | Mega-cap persistence |
| `accel_streak_uptrend_call` | call | **Momentum** | 4 up days + EMA50/SMA20 | Grind continuation |
| `accel_dual_momentum_call` | call | **Momentum** | mom5>4, mom10>7, EMA50 | Dual-horizon |
| `accel_rsi_cross60_call` | call | **Momentum** | RSI cross 60 + SMA20 | Strength ignition |
| `accel_macd_flip_near_high_call` | call | **Momentum** | MACD flip + near high + EMA50 | Front-run breakout |
| `donchian_breakout_trend` | call | **Breakout** | 20d high + EMA50 + SMA20 | Day-1 continuation |
| `vol_expand_breakout_call` | call | **Momentum** | breakout + 1.5× vol | Ignition vs drift |
| `vol_expand_momo_burst_call` | call | **Momentum** | +2.5%, 1.8× vol, mom5>3 | Gap-and-go |
| `dip_buy_near_highs_call` | call | **Pullback / MR-lite** | RSI<42, EMA50, near high | Winner’s breather |
| `rsi_turn_up_call` | call | **MR-lite** | RSI cross 38 + trend | Bounce already on |
| `bollinger_break_uptrend_dip` | call | **MR** | lower band + RSI<35 + EMA50 | Shakeout snap |
| `capitulation_flush_rebound` | call | **MR** | −4%, RSI<30, 2× vol | V-bounce |
| `oversold_rsi_cross_snapback` | call | **MR** | RSI cross 30 + 1.3× vol | Confirmed turn |
| `put_breakdown_stacked_trend` | put | **Trend** | 20d low + SMA20 + EMA50 | Sustained leg down |
| `put_vol_expansion_thrust` | put | **Momentum** | −1.8%, 1.8× vol, below SMA20 | Vol begets vol |
| `put_momentum_decay_consec` | put | **Momentum** | mom5<−4, 3 down days, EMA50 | Lost bid |
| `put_overbought_rsi_rolldown` | put | **MR fade** | RSI cross 70 + 1.3× vol | Rally actually breaks |
| `spyqqq_breakdown_hedge_put` | put | **Trend / hedge** | 20d low + EMA50 + 1.5× vol | Index elevator down |

**Count:** 14 clearly momentum/breakout/trend, 8 mean-reversion or pullback, 2 labeled “classic” baselines that are still MR (`rsi_dip`, `rsi_hot`). The leaderboard ranks by **expectancy**, not win rate — the house profile is low hit-rate / high skew.

### 2.3 Other bot factories (not a third library)

| Source | File | What it creates | Enabled? |
| --- | --- | --- | --- |
| Playbooks | `backend/src/seed/playbooks.ts` | Disabled observe bots from 2x–10x option theses (MSFT RSI bounce, AMD pullback, QQQ breakout, META/TSLA fades, …) | no |
| Learning iterator | `backend/src/learning.ts` `createIdeaBot` | Ideas that pass ≥20 trades, +expectancy, both halves → `enabled=0`, `mode: 'cautious'`, `action._idea` | no; retire after 8 losing paper trades |
| Campaign phases | `backend/src/campaign.ts` | Suggested MU/CEG/etc. option plays inside a $1k→$100k narrative | coaching, not auto-enabled |
| BotWizard presets | `frontend/src/components/BotWizard.tsx` | rsi-dip, ema-cross, breakout, macd, breakdown, overbought | user choice; default observe + off |
| `REGIME` scorer | `backend/src/market/regime.ts` | **Not a bot.** Static H2-2026 badge (asOf `2026-06-21`) on existing bots | — |

The iterator’s allowed keys (`learning.ts` `TRIGGERS` / `FILTERS`) **do not include** `residual_z_below`. The model cannot mint the stub’s rule by accident.

### 2.4 Style mix (honest)

| Style | Library | QuickBots | Notes |
| --- | --- | --- | --- |
| Momentum / trend / breakout | 12 / 19 | 14 / 24 | Dominant. Day “ORB” is misnamed. |
| Mean reversion / fade | 4 / 19 | 8 / 24 | Single-name RSI/Bollinger only |
| Stat-arb / pairs | 1 stub | 0 | New; long the laggard only |
| Earnings / IV crush | 0 | 0 | Calendar is seed data; IV not in rules |
| Breadth / live regime | 0 | 0 | `REGIME` is a dated essay, not a feed |
| News + fundamentals | 2 AI-gated | 0 | LLM can block; LLM cannot size or place |
| Multi-leg defined-risk | 0 | 0 | Roadmap; long premium is the only option structure |

---

## 3. Risk engine

Single function `riskCheck` in `backend/src/risk/engine.ts`. Caps resolved by `resolveCaps()` (global from `.env` / Settings, bot can only **tighten** unless `risk.override` — and override is **clamped**: daily-loss ≤ 50%, concentration ≤ 95%). Play DTE caps can only tighten further. Sizer (`risk/sizing.ts`) uses the **same** ceiling.

### 3.1 Hard blocks (never bypassed, including `full_auto`)

1. **Kill switch** — blocks **buys** only. Sells (close-only) pass. Re-checked at `brokers/index.ts`. Worker also skips bot **entries**.
2. **No crypto** — `HARD_BLOCKED_ASSET_CLASSES` + `isCryptoSymbol()` (`config.ts`). Not a setting. Re-checked at broker boundary. Bot eval skips the symbol.
3. **Asset allowlist** — default `equity,etf,option` (`ALLOWED_ASSET_CLASSES`).
4. **Long only / no short** — sell qty ≤ held. Options: held **OCC contract**, not shares. Unidentified contract → held=0 → fail-closed.
5. **No naked write** — option sell with qty > held contracts. Covered calls vs shares stay **manual** and are still blocked if they exceed option inventory.
6. **Unpriceable option buy** — notional 0 → veto (cannot size).
7. **Daily-loss breaker** — vs env day-start equity (ET calendar). Live + unknown equity → **fail-closed** on buys.
8. **Live concentration fail-closed** — live buy with equity ≤ 0 is a safety veto; `full_auto` must not bypass it.

### 3.2 Soft caps (bypassed only in `full_auto`)

Defaults from `.env.example`: `MAX_POSITION_USD=2000`, `MAX_PORTFOLIO_CONCENTRATION_PCT=25`, `MAX_DAILY_LOSS_PCT=3`, `MAX_ORDERS_PER_DAY=40`. Concentration includes today’s in-flight buys. Orders/day counts **buys** only.

### 3.3 Exits (protection, not exposure)

`risk/exitpolicy.ts` is shared by live monitors and QuickBot backtests: small SL, optional TP (0 = off), breakeven lock at +30% peak, ratcheting trail. Monitors (`risk/monitor.ts`) close only on a **fill**; a failed exit stays open and retries. Default hold policy flattens before the close / weekend (overridable per bot). Monitor loop **ignores** the kill switch on purpose.

### 3.4 What is not a risk rail

- Campaign `$1k → $100k` phases (`campaign.ts`) are coaching. They do not bind `riskCheck`.
- `REGIME` badges do not block orders.
- News alerts do not place or block.
- Promotion (`promotion.ts`) never flips `TRADING_ENV`. It marks graduated and drops the bot to **cautious**.

---

## 4. AI layer — propose, never dispose

Task router: `backend/src/ai/models.ts`. Six tasks, ordered chains, `/models` probe at boot + 6h, `LLM_POISON_PROVIDERS` for drills. No key → deterministic path still runs; research/chat/agent/ideas go quiet.

| Task | Used by | Must not do |
| --- | --- | --- |
| `chat` | Ask AI (`assistantChat`) | Write SQL; tools are read-only SELECT + RAG |
| `triage` | `newsMonitor`, focus cheap reads | Place, size, or enable a bot |
| `research` | `analyzeSymbol`, news escalate, AI gates | Bypass a failed technical filter |
| `agent` | `POST /api/agent` `propose_order` | Reach a broker; still `executeDraft` |
| `review` | Daily coaching, learning evidence pack | Enable bots or raise mode |
| `ideas` | Iterator new rules | Emit keys outside `TRIGGERS`/`FILTERS`; enable the child bot |

**Law in `ai/claude.ts` `SYSTEM_RULES`:** no crypto, long only, “You PROPOSE; deterministic code DISPOSES.”

### 4.1 What must NOT be left to an LLM

| Decision | Owner | Why |
| --- | --- | --- |
| Whether an order may exist | `riskCheck` + `placeOrder` | Hallucinated size/side/symbol |
| Crypto / short / naked write | Hard blocks, twice | Permanent policy |
| Kill switch | Settings + risk + broker | Asymmetric on purpose |
| Contract identity + premium | `resolveDraftContract` | Unpriced option = no trade |
| Fill prices / P/L | Broker + monitors | Never invent fills (`SYSTEM_RULES`) |
| Enable / mode escalate | Human (or iterator **disabled** insert) | `learning.ts` hard rules |
| Env paper → live | `POST /api/env` + confirm | Real money |
| Daily-loss / concentration math | Equity snapshots | Fail-closed when stale |
| Entry/exit arithmetic | `evalRules` + `exitReason` | Live and backtest must match |

**Safe LLM jobs:** classify a headline as tradeable (then write an **alert**, not an order); draft a thesis; emit a rule object in the engine’s vocabulary for a **disabled** backtest; answer SELECT questions about *this* database.

**AI-gate behaviour:** if the model throws, `aiOk = false` — the trade does **not** go through. That is correct for a gate. It is also why a paper desk should not depend on a gate for edge.

---

## 5. Gaps Eric would care about (paper Ulric desk)

Prioritized for a public paper book: honesty, diversification of *style*, and not embarrassing the desk with look-ahead or silent disables.

1. **Style concentration.** The live catalog is mostly the same trade: trend + momentum, often on Mag-7 weeklies. A public P/L that only works in a melt-up is a narrative risk, not just a Sharpe issue.
2. **Bot mode vs global Observe.** Chrome can say Observe while a bot in `auto` still places (`modeOverride: bot.mode`). For a public desk, clamp `effectiveMode = min(global, bot)` or refuse `auto` when global is `observe`.
3. **Intraday labels vs daily bars.** `momentum-day`, `opening-breakout`, `mean-reversion-day` claim `5m` and never fetch it. ORB is not an opening range. Either implement true ORB (session high after 09:30–09:45 ET) or rename.
4. **`REGIME` is frozen (2026-06-21).** Learning already computes live SPY/QQQ SMA/RSI from `market_bars` (`learning.ts` evidence pack) and then **does not gate entries**. A live breadth/regime filter is the highest-leverage overlay — it upgrades every existing bot without new signals.
5. **Earnings and IV are on disk / on the wire, not in `evalRules`.** `earnings` + `earnings_docs` are seed scripts. Alpaca snapshots expose `impliedVolatility` (`brokers/options.ts`) but rules never see IV rank or DTE-to-print. Classic short-vol crush is also **illegal here** (no naked write, no multi-leg).
6. **No two-name evaluator (until this stub).** `evalRules` is one series. Portfolio risk already has Pearson on 90d bars (`portfolio/risk.ts`) and does not trade it.
7. **Day-trade library + 4 entries/day on a daily signal.** A persistent daily trigger can add up to 4 times, 45 minutes apart. Fine for a swing; dangerous for a “day” bot that is actually daily.
8. **Focus mode** redirects *every* enabled bot onto one ticker — concentration can blow the 25% cap via several bots in one cycle (partially mitigated by pending-buy sum in `riskCheck`).
9. **Learning iterator will keep proposing more momentum.** Vocabulary = the same RSI/MACD/Donchian keys. Without new keys (residual, earnings window, breadth), “ideas” are mutations of the existing book.
10. **Promotion gate is QuickBot-shaped.** Non-Quick library bots get a non-critical “run Backtest tab yourself” item (`promotion.ts`). Paper Ulric needs the same OOS bar for equity rules.
11. **No automated tests** on `riskCheck` / `evalRules` / residual (README roadmap). A public desk should add them before any mode above cautious.
12. **Campaign math vs risk caps.** A $1k→$100k options story fights `MAX_DAILY_LOSS_PCT=3` and long-only premium. Fine as fiction; do not let coaching imply the rails will be lifted.
13. **Roadmap already named:** multi-leg defined-risk, evidence-based paper→live promotion, risk-engine test suite, Linux/Windows verify.

---

## 6. New bot designs (not pure momentum)

Each design is written to **plug into the existing bot row + `executeDraft`**. None of them short stock, write options, or let an LLM size. Paper plan is observe-first.

Research touchstones (public, not advice): Jegadeesh/Titman (momentum *and* its reversal cousin), De Bondt/Thaler (overreaction), Gatev/Goetzmann/Rouwenhorst (pairs), Ball/Brown and Bernard/Thomas (PEAD), Nagel (VIX / risk-off), Bakshi/Kapadia (variance risk premium — **we cannot harvest it by selling**).

### 6.1 Residual reversion vs SPY — **stub in this PR**

**Hypothesis.** A liquid name’s 60-day log-spread vs SPY mean-reverts. Buying only when the residual z is very negative *and* RSI is washed out *and* price is still above SMA20 is fading a dip in an intact uptrend — not chasing 20-day highs, not shorting the index.

**Entry (deterministic).** `residual_z_below: -2` AND `rsi_below: 35` AND filter `price_above_sma20`. Benchmark `SPY`. Same-symbol or missing bars → residual is null → **fail-closed**.

**Exit.** Existing monitor: small SL / trail from trade defaults. Do **not** use the QuickBot “uncapped winner” profile here; MR wants a mid-band / z > −0.5 style exit (trail 8–12% equity, or flatten when residual z crosses −0.25). Per-bot `risk` can set that without engine changes.

**Data in repo.** `market_bars` + `refreshBars`. Helper: `backend/src/market/residual.ts`. Wired in `evaluateBot` only when the rule key is present.

**Missing for a serious book.** Rolling beta (β=1 log-ratio is the lite version); sector ETF benchmark (XLK vs NVDA); entry at prior-bar z (no same-bar look-ahead — residual uses the same last close as other rules); half-spread cost in the equity backtester; residual not yet in `backtest.ts` (so the Backtest tab will fail-closed until wired).

**Risk.** Long-only half-spread: if SPY dumps, a “cheap” name can cheapen further. SMA20 filter is the circuit. Cap `max_position_usd` at the global default or tighter. No options on v1 (premium + residual is two models of the same bet).

**Plug-in.** Library key `residual-reversion-spy`. `seedStrategies` inserts `enabled=0`, `mode=observe`, `action._proposal_stub=true`. **Not** in `learning.ts` vocabulary. **Not** in QuickBot `CANDIDATES`. Existing accounts do not get the row until `POST /api/strategies/seed` (or a new env fleet).

**Paper-test plan.**

1. Leave **disabled**. Confirm `GET /api/strategies` shows the template.
2. Seed on paper. Confirm the bot row is `enabled=0`, `mode=observe`.
3. Enable **only** on `alpaca_paper` while global mode is observe. `POST /api/bots/:id/evaluate` — expect `signals` with residual z in `checks`, `orders.status=draft`.
4. Do not raise mode until ≥20 observe drafts and a residual-aware backtest (both halves positive). Promotion checklist as-is will mark non-Quick bots “manual backtest.”

### 6.2 Pair residual (stock vs sector ETF) — long the laggard only

**Hypothesis.** NVDA vs XLK (or XOM vs XLE) is a tighter spread than NVDA vs SPY. Gatev et al. pairs: trade when z < −2, exit at z ≈ 0. We **cannot** short the rich leg. So: buy the laggard only; sit out if the *name* is the rich leg (z > +2 is a pass, not a short).

**Entry.** Same `residual_z_below` + `benchmark: 'XLK'` (already a string on the rules object). Add a **hard skip** if residual z > 0 (already implied). Optional: `vol_expand` off — we want a quiet dislocation, not a crash.

**Exit.** Flatten when residual z ≥ −0.25 or time-stop 10 sessions (`risk.hold` + monitor). 

**Data in repo.** Bars for ETFs if Alpaca has them (XLK, XLE, XLF, XBI). Correlation matrix in `portfolio/risk.ts` can *pick* pairs, not trade them.

**Missing.** Pair picker (cointegration / half-life). `evalRules` still one symbol per pass — the stub already fetches a second series; a pair bot is the same hook with a different benchmark. No short hedge, so this is **not** dollar-neutral.

**Risk.** Residual can become a downtrend. Require `price_above_sma20` or `above_ema50`. One pair, one lot, observe.

**Plug-in.** Clone the stub row; change `benchmark` + symbols. No new engine keys.

**Paper-test.** Walk-forward on 2–3 pairs, 252 days, cost 10 bps/side. Reject if the edge is only 2023–24 mega-cap. Enable observe on **one** pair for 20 sessions.

### 6.3 Post-earnings drift (PEAD) — not IV crush

**Hypothesis.** After a **confirmed** report, the surprise direction continues for days (Ball/Brown, Bernard/Thomas). That is the opposite of “sell the crush.” Short straddles / iron condors are **blocked** (naked write, no multi-leg). Buying premium *into* the print donates the crush. So: **no new option buys inside N days before the print**; **after** the print, a small **equity** (or cheap post-crush call) in the surprise direction if the gap holds.

**Entry (deterministic).**

- Pre: `days_to_earnings` in (0, 5] → **filter fail** (blackout). Needs a live calendar.
- Post: report_date was yesterday or today; `eps_actual` vs `eps_estimate` parsed; gap held into the close; optional `rsi` not insane. Buy shares, not weeklies, on v1.

**Exit.** 5–10 sessions or trail 8%. No overnight into the *next* name’s print.

**Data in repo.** `earnings` table + RH MCP `getEarningsCalendar` / `getEarningsResults` (`rh/mcpClient.ts`) — **not called by the worker**. Seed rows in `seed/research.ts` / `seed/macro.ts` are static and will rot.

**Missing.** A sync job → `earnings` (RH when connected, else a dated public calendar). Numeric EPS fields (schema is `VARCHAR`). IV rank if we later allow a **post-crush** cheap call (Alpaca snapshot `iv` is live, not stored).

**Risk.** Gap risk is *why* we wait for the hold. Size at half `MAX_POSITION_USD`. LLM may **summarize** a transcript (`earnings_docs`) as a *filter* (“guidance cut” → skip) and must not flip the sign.

**Plug-in.** New filter keys `earnings_blackout_days` / `earnings_hold_days` evaluated in `evaluateBot` (async DB), same fail-closed pattern as residual. Do not add to iterator vocabulary until the calendar is live.

**Paper-test.** Replay last 8 quarters on Mag-7 + IWM names from a real calendar dump. Count: blackout prevented any option buy in the 5d window; PEAD entries only after a hold. Observe for a full earnings season before cautious.

### 6.4 Breadth / regime overlay (not a profit bot)

**Hypothesis.** Most of this book is long momentum. It should **not buy** when the tape is risk-off. Nagel-style: when the index is below a slow average and realized vol is expanded, stand down. This is a **filter on the fleet**, not a new alpha source.

**Entry.** No new entries. Implementation options (prefer #1):

1. Worker-level gate: if SPY close < SMA200 **or** SPY 20d realized vol > k × its 1y median, skip `evaluateAllEnabledBots` **buys** (still run monitors). Log a single `signals`-like audit row `regime.stand_down`.
2. Per-bot filter `spy_above_sma200: true` attached to momentum library keys only (leave residual / put / MR free).

**Exit.** N/A. Existing stops remain the protection.

**Data in repo.** Already computed in the learning evidence pack (`learning.ts` SPY/QQQ block). `REGIME` in `market/regime.ts` should become a **comment** pointing at the live calc, or be date-stamped so it cannot silently score 2027 bots.

**Missing.** True breadth (advancers/decliners, % above 50d). Alpaca bars on a 20-name watchlist can fake “% of Mag-7 above SMA50” without a new vendor. VIX itself is not in the stack; realized vol is.

**Risk.** Standing down is the point. Do not invert this into “buy puts on every SMA200 break” without a separate, small, observe put bot (`spyqqq_breakdown_hedge_put` already exists).

**Plug-in.** `worker.ts` bots loop, or a filter key + one extra `closesFor('SPY')`. Default **on** for library momentum, **off** for the residual stub.

**Paper-test.** Replay 2022 and 2025 Q1-style tapes: count momentum entries avoided vs naked library. Overlay must not change exit fills.

### 6.5 News + fundamental hybrid — LLM is triage only

**Hypothesis.** Alpaca headlines already land in `news`. `newsMonitor()` already flags tradeable items and writes `alerts` with `bot_ids`. The missing piece is a **deterministic** bot that may fire only when (a) a fresh `trade`/`watch` alert exists for the symbol, (b) a technical trigger that is **not** “up a lot,” and (c) the research task is **not** on the critical path to `executeDraft`.

**Entry.**

- Trigger: `rsi_below: 32` or `bollinger_lower` (dip, not breakout).
- Filters: `price_above_sma20`; `alert_max_age_hours: 12` (new, fail-closed if no row); optional `earnings_blackout_days: 3`.
- `ai_gate.enabled: false`. The LLM has already done its job in `advisor.ts` (headline marked DATA, not instructions).

**Exit.** Standard swing SL/trail. If the alert was bearish, this bot does not flip to puts — a **separate** observe put bot can subscribe to bearish alerts.

**Data in repo.** `alerts`, `news`, `research_notes`. Fundamentals endpoint is RH-gated (`GET /api/fundamentals/:symbol`).

**Missing.** `alert_max_age_hours` evaluator (one SQL in `evaluateBot`). Dedup so a stale headline cannot re-trigger after the 45-min cooldown four times.

**Risk.** Prompt injection is already treated (headlines wrapped as DATA). Still: never let `POST /api/agent` run unattended on a public stream. Agent `propose_order` is a foot-gun if global mode is `auto`.

**Plug-in.** New library row, observe, disabled, `ai_gate` off. Consumes alerts; does not call `analyzeSymbol` on the hot path (token + latency + another failure mode).

**Paper-test.** Two weeks of observe: every draft must cite `alerts.id` in `orders.rationale`. Spot-check that a “noise” headline (triage `tradeable=false`) never appears. Compare vs `ai-conviction-swing` (which *does* call Claude on every fire).

### 6.6 What we are **not** proposing

- **Short-vol / iron condor / covered call income.** Blocked by long-only and no multi-leg. The variance risk premium is real and **unavailable** on this stack. Do not fake it with “buy a put and a call” as a straddle — that is long vol into the crush.
- **LLM-picked entries** (`full_auto` agent). Useful as a toy; not a public book.
- **Crypto, leverage ETFs as a “hedge,” or alpaca_live.** Out of policy / not wired.

---

## 7. Safety posture for this work

- No orders were placed. No `.env` defaults changed (`DEFAULT_MODE=observe`, caps, allowlist, crypto block).
- Stub: `enabled=0`, `mode=observe` even when the fleet seed asks for cautious. Residual trigger fail-closes without a benchmark series. Key is **absent** from the idea iterator.
- Enabling the stub is a human action. Raising its mode above observe is a second human action. Switching to `robinhood_live` remains a third, confirmed action.

---

## Appendix A — signal → order (sequence)

1. `worker` 120s, market open, kill off → `evaluateAllEnabledBots` (`fleet` env only).
2. `evalRules` + optional residual attach + optional AI gate.
3. `INSERT signals`.
4. `reentryGate` / in-flight lock.
5. `sizeDraft` then `executeDraft`.
6. `riskCheck` + mode → draft / staged / placed / vetoed.
7. Broker re-check; monitor opened on bot/AI buy fills.

## Appendix B — file index (bots / risk / AI)

```
backend/src/index.ts              boot
backend/src/routes/api.ts          HTTP
backend/src/worker.ts              schedule
backend/src/execute.ts             chokepoint
backend/src/config.ts              modes, env, crypto, caps
backend/src/bots/engine.ts         evalRules, evaluateBot
backend/src/bots/strategies.ts     library + stub
backend/src/quickbot.ts            short-DTE catalog
backend/src/fleet.ts               per-account seed
backend/src/learning.ts            iterator
backend/src/promotion.ts           paper → cautious live
backend/src/risk/engine.ts         riskCheck
backend/src/risk/sizing.ts         dollars → qty
backend/src/risk/exitpolicy.ts     shared exits
backend/src/risk/monitor.ts        live TP/SL
backend/src/brokers/index.ts       place + sync
backend/src/brokers/options.ts     chain, IV on snapshots
backend/src/market/residual.ts     log-spread z (new)
backend/src/market/regime.ts       static H2-2026 badge
backend/src/ai/models.ts           task chains
backend/src/ai/claude.ts           research, chat, agent
backend/src/ai/advisor.ts          news triage / review
db/schema.sql                      tables
```
