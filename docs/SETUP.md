# rh-trader: manual setup

The step-by-step path. If you would rather have a coding agent do this for you, use
[`SETUP-PROMPT.md`](SETUP-PROMPT.md) instead; it performs exactly these steps and asks you for
the same answers.

Time: about 15 minutes, most of it waiting on `npm install` and creating broker accounts.

---

## 1. Prerequisites

| Requirement | Check | If missing |
| --- | --- | --- |
| Node 22 or newer | `node -v` | [nodejs.org](https://nodejs.org/) or `brew install node@22` or `nvm install 22` |
| npm | `npm -v` | ships with Node |
| MySQL 5.7 or 8 | `mysql --version` | `brew install mysql` and `brew services start mysql`, or Docker, or MAMP, or any MySQL you already run |
| git | `git --version` | Xcode command line tools, or your package manager |

MySQL 5.7 is the floor because the schema uses `JSON` columns and an InnoDB `FULLTEXT` index.
Any MySQL that answers on a host and port will do: local install, Docker container, MAMP.
Nothing in the app cares which one, only the four connection values in `.env`.

Optional, only for the native macOS window: Rust and the Tauri CLI.

---

## 2. Clone and install

```bash
git clone https://github.com/erichers/rh-trader.git
cd rh-trader
(cd backend && npm install)
(cd frontend && npm install)
```

---

## 3. Create the database

`db/schema.sql` creates the database (`rh_tradingbot`), the tables, and the indexes. It is
idempotent, so re-running it is safe.

```bash
# Standard local MySQL on 3306:
mysql -h 127.0.0.1 -P 3306 -u root -p < db/schema.sql

# MAMP MySQL on 8889:
/Applications/MAMP/Library/bin/mysql -h 127.0.0.1 -P 8889 -u root -proot < db/schema.sql
```

On boot the backend runs `migrate()`, which adds any missing columns and indexes with
`information_schema` checks first. It never drops anything and it is safe to run against a
database that is already current.

If you prefer a least-privilege user over `root`:

```sql
CREATE USER 'rhtrader'@'127.0.0.1' IDENTIFIED BY 'a-password-you-choose';
GRANT SELECT, INSERT, UPDATE, DELETE, CREATE, ALTER, INDEX ON rh_tradingbot.* TO 'rhtrader'@'127.0.0.1';
FLUSH PRIVILEGES;
```

`CREATE`, `ALTER` and `INDEX` are needed because `migrate()` runs on every boot.

---

## 4. Configuration

```bash
cp .env.example .env
```

Then edit `.env`. The values that matter first:

```ini
# Database (match your MySQL, not the author's)
DB_HOST=127.0.0.1
DB_PORT=3306          # 8889 if you use MAMP
DB_USER=root
DB_PASSWORD=
DB_NAME=rh_tradingbot

# Server
PORT=8011
BASE_PATH=/rh.tradingbot   # only used by the optional Apache mapping

# Safety (leave these alone until you have watched it run)
DEFAULT_MODE=observe
KILL_SWITCH=false
ALLOWED_ASSET_CLASSES=equity,etf,option
MAX_POSITION_USD=2000
MAX_PORTFOLIO_CONCENTRATION_PCT=25
MAX_DAILY_LOSS_PCT=3
MAX_ORDERS_PER_DAY=40
```

`.env.example` does not yet list the broker environment keys. Add these lines yourself
(the backend reads them from `process.env`; see `backend/src/config.ts`):

```ini
# Which broker orders route to: alpaca_paper (fake money) or robinhood_live (REAL money)
TRADING_ENV=alpaca_paper

# Alpaca (paper trading + all market data, bars, option chains, market clock)
ALPACA_API_KEY=
ALPACA_SECRET_KEY=
```

`.env` is gitignored, along with `.env.*` except the example. Keep it that way.

---

## 5. Alpaca paper keys

Alpaca provides the paper account and every quote, bar, option chain and market-clock call the
app makes, in both environments. Get keys before anything else.

1. Create a free account at [alpaca.markets](https://alpaca.markets/).
2. Open the dashboard at [app.alpaca.markets](https://app.alpaca.markets/) and make sure you are
   on **Paper Trading**, not Live. The toggle is in the sidebar.
3. Generate an API key pair. The secret is displayed once. Copy both values now.
4. Put them in `.env` as `ALPACA_API_KEY` and `ALPACA_SECRET_KEY`.

The app only ever constructs the paper trading client (`brokers/index.ts` returns
`alpacaPaper` for every Alpaca environment), so paper keys are sufficient and safer. There is
no `alpaca_live` environment.

---

## 6. LLM providers (optional, but most of the interesting parts need one)

Pick whichever you have. The router uses what is configured and skips the rest. With none of
them, bots, rules, backtests, monitors and the risk engine all still work; research, news
triage, Ask AI, the trade agent and the learning iterator go quiet.

| Provider | Where to get a key | `.env` |
| --- | --- | --- |
| Groq (free tier) | [console.groq.com/keys](https://console.groq.com/keys) | `GROQ_API_KEY` |
| NVIDIA NIM (free developer tier, plus embeddings) | [build.nvidia.com](https://build.nvidia.com/) | `NVIDIA_API_KEY` |
| Kimi / Moonshot (paid) | [platform.moonshot.ai](https://platform.moonshot.ai/) | `KIMI_API_KEY` |
| Anthropic (paid) | [console.anthropic.com](https://console.anthropic.com/) | `ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL` |
| Muse Spark / Meta Model API | [ai.developer.meta.com](https://ai.developer.meta.com/) | `META_MUSE_API_KEY` (or `MUSE_API_KEY` / `MODEL_API_KEY`), optional `META_MUSE_MODEL` |
| Local, OpenAI-compatible | Ollama or LM Studio, running on your machine | `LOCAL_BASE_URL`, `LOCAL_MODEL`, `LOCAL_API_KEY` |

For a local server:

```ini
# Ollama
LOCAL_BASE_URL=http://localhost:11434/v1
LOCAL_MODEL=qwen2.5:14b-instruct
LOCAL_API_KEY=ollama          # Ollama ignores the value, but the header must exist

# LM Studio
LOCAL_BASE_URL=http://localhost:1234/v1
LOCAL_MODEL=<the id shown in the LM Studio server tab>
LOCAL_API_KEY=lm-studio
```

Whatever you set as `LOCAL_MODEL` must be the exact id the server returns from
`GET /v1/models`; the boot probe checks it and says so in the log if it is not there. Read the
local model caveats in the main README before pointing a small model at the `agent`, `review` or
`ideas` tasks.

`GROQ_MODEL`, `KIMI_MODEL`, `NVIDIA_MODEL`, `ANTHROPIC_MODEL` and `META_MUSE_MODEL` (or
`MUSE_MODEL`) are optional overrides. Leave them empty and the router picks the top live id
on each provider's ladder. Muse defaults to `muse-spark-1.3` and walks to `muse-spark-1.1`.

**Safety loop.** Stay on `TRADING_ENV=alpaca_paper` and `DEFAULT_MODE=observe` while you try
Muse. Keys live only in `.env` (gitignored). Adding a provider never places an order.

**Iteration loop.** With a Meta key, the daily journal / learning review (`review` task) leads
with Muse Spark. In `observe` that pass writes lessons and staged ideas only.

---

## 7. Build and run

```bash
(cd frontend && npm run build)   # produces frontend/dist, which the backend serves
(cd backend  && npm start)       # Fastify on http://127.0.0.1:8011
```

For development with hot reload, `./scripts/dev.sh` runs the backend under `tsx watch` on
:8011 and the Vite dev server on :5173 with a proxy for `/api` and `/ws`.

The backend restarts do not reload `.env` by themselves in `npm start` mode (no watcher):
after editing `.env`, restart the process.

---

## 8. Verify

```bash
curl -s http://127.0.0.1:8011/api/health
```

Expect JSON with `"ok": true`, `"db": true`, your `env` (`alpaca_paper`), `"live": false`,
`mode` (`observe`), `killSwitch`, and a `broker` block with `alpacaConfigured: true` once your
keys are in place.

```bash
curl -s http://127.0.0.1:8011/api/ai/models
```

Expect a `tasks` object listing the resolved chain for `chat`, `triage`, `research`, `agent`,
`review` and `ideas`, and a `providers` object with `configured`, `live_ids`, `probed_at` and
`error` per provider. `live_ids: 0` with an `error` string means that provider's key or base URL
is wrong. An unconfigured provider simply does not appear in any chain.

Then open <http://127.0.0.1:8011/>. If you see a JSON note saying the frontend is not built,
run the frontend build from step 7.

Sanity check inside the app: Settings shows the active environment and the model per task, the
Bots page shows a seeded fleet with everything disabled, and the status pill in the header
reports the database and Robinhood connection state over the `/ws` socket.

---

## 9. Connect Robinhood (optional, and this is the real-money path)

Skip this entirely if you want to stay in paper. Nothing else depends on it.

What you are connecting to: Robinhood's agentic MCP endpoint at
`https://agent.robinhood.com/mcp/trading`. Onboarding creates a **Robinhood Agentic account**,
a separate account that agents can trade and that starts unfunded. Every other account in your
Robinhood profile stays read-only to the agent. It requires a primary individual investing
account in good standing and a desktop browser.

Two ways to authorize:

```bash
cd backend && npm run rh:auth
```

The CLI opens your browser, listens on `http://localhost:7321/callback` for the redirect
(`RH_OAUTH_CALLBACK_PORT`), exchanges the code, and writes tokens to
`backend/data/oauth-tokens.json` and the `oauth_tokens` table. Both are gitignored.

Or, with the backend already running, use **Settings, Connect** in the app: it starts the same
flow and the backend's callback server completes it.

After authorizing:

1. Fund the agentic account deliberately from the Robinhood app. The agent can only use money
   you moved there.
2. Switch the trading environment to `robinhood_live`. The API refuses without explicit
   confirmation:
   ```bash
   curl -s -X POST http://127.0.0.1:8011/api/env \
     -H 'content-type: application/json' \
     -d '{"env":"robinhood_live","confirm":true}'
   ```
   The interface asks you to confirm the same thing.
3. The new account gets its own fleet: fresh bots, all disabled, all cautious. Nothing carries
   over from paper.
4. Watch the switch response for a warning about open position monitors on the environment you
   just left. Stops are only evaluated for the active environment, so leaving an environment with
   open positions pauses those stops until you switch back.

Robinhood sends a push notification on every agent trade, and you can disconnect the agent from
the Robinhood app at any time.

`docs/robinhood-mcp.md` documents the capability surface: what the agent may read, what it may
place, order types, and what is not available.

---

## 10. Optional: Apache or MAMP in front

Not required. The Fastify server already serves the SPA. If you want the app at a path on a
local Apache instead of on :8011, `deploy/apache-rh.tradingbot.conf` holds a managed block that
proxies a path prefix (`BASE_PATH`) plus `/api` and `/ws` to :8011, and `scripts/run-web.sh`
builds the SPA, restarts the backend and reloads Apache in one step. That script hardcodes MAMP
paths and MAMP's MySQL on :8889, so adapt it if your setup differs.

The Vite build uses a relative base, so the same `frontend/dist` works served from `/`, from a
path prefix, or inside the Tauri window.

---

## 11. Optional: native macOS window

```bash
./scripts/run-native.sh          # dev window
./scripts/run-native.sh build    # .app and .dmg bundle
```

Requires Rust and `cargo tauri`. The window is a thin wrapper around
`http://127.0.0.1:8011/`, so the backend must be running either way. Like `run-web.sh`, this
script assumes MAMP paths for MySQL.

---

## Troubleshooting

**`migrate failed (non-fatal)` at boot, then `db: false` on `/api/health`.** The connection
values in `.env` are wrong or MySQL is not running. Test them directly with the same host,
port, user and password.

**MySQL 8 rejects the connection with an auth plugin error.** Either create the user with
`mysql_native_password`, or use a client library setting your MySQL accepts. `mysql2` handles
`caching_sha2_password` over a plain TCP connection to localhost in current versions; upgrading
the dependency is the easier fix.

**`EADDRINUSE` on 8011.** Something else has the port. Change `PORT` in `.env`, or stop the old
process (`pkill -f "tsx src/index.ts"`).

**`/api/ai/models` shows a provider with `error` and zero live ids.** Bad key, wrong base URL,
or the provider is down. The chain skips it; the app keeps working through the next rung.

**Nothing happens during market hours.** Check that bots are enabled (they ship disabled), that
the global mode is not `observe`, and that `/api/clock` reports the market as open. Bots only
evaluate while the market is open.

**A learning-run idea was discarded even though its backtest looked fine.** The gate is
deliberate: at least 20 trades in the test window, positive expectancy, and a positive average
return in both halves of that window with at least 3 trades in each half. An idea that fails is
recorded with its numbers and dropped.
