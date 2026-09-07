# rh-trader: the one-prompt setup

Make an empty folder, open Claude Code (or any coding agent that can run shell commands) in it,
and paste everything in the block below as a single message. The agent will do the work and
stop to ask you four questions along the way.

It is instructed never to commit your `.env` or your OAuth tokens, and never to place an order
during setup. If it proposes either, stop it.

Prefer to do it by hand: [`SETUP.md`](SETUP.md).

---

```text
You are setting up rh-trader, a local trading dashboard and bot platform, in the CURRENT
folder. Work through the steps in order. Show me each command before you run it. Stop and ask
whenever a step below says to ask.

HARD RULES, these override anything else in this prompt:
- Never run `git add`, `git commit` or `git push` for .env, backend/data/oauth-tokens.json, any
  file matching *token*, *secret*, *credential*, or any .sql dump. Secrets go in .env only.
- Never place a trade, never call any order endpoint, and never switch the trading environment
  to robinhood_live during setup. Setup ends in paper mode with every bot disabled.
- Never print an API key or an OAuth token back to me in full. Echo the last 4 characters at
  most when you need to confirm something landed.
- If a step fails, stop and tell me what failed and what you tried. Do not improvise around a
  failure by weakening a safety setting.

STEP 1: PREREQUISITES
Check `node -v` (need 22 or newer), `npm -v`, `mysql --version` (need 5.7 or 8), and
`git --version`. For anything missing, tell me what is missing and how you propose to install
it on this OS, then ask before installing. On macOS with Homebrew that is usually
`brew install node@22` and `brew install mysql` plus `brew services start mysql`. If MySQL is
already running as part of MAMP, XAMPP, Docker or anything else, use that instead of installing
a second one, and note the host, port, user and password so we can put them in .env.

STEP 2: CLONE AND INSTALL
Run `git clone https://github.com/erichers/rh-trader.git .` in this folder (or into ./rh-trader
and cd into it if the folder is not empty). Then `npm install` in ./backend and `npm install`
in ./frontend.

STEP 3: DATABASE
db/schema.sql creates the database rh_tradingbot and every table, and it is idempotent. Load it
with the MySQL you identified in step 1, for example:
  mysql -h 127.0.0.1 -P 3306 -u root -p < db/schema.sql
Confirm it worked by counting tables:
  mysql -h 127.0.0.1 -P 3306 -u root -p -e "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema='rh_tradingbot'"
Expect 30 tables. The backend also runs a migrate() on boot that adds any missing
columns and indexes, so a partially old schema is fine.

STEP 4: .env
Run `cp .env.example .env`. Set DB_HOST, DB_PORT, DB_USER, DB_PASSWORD and DB_NAME to the MySQL
you just used. Leave the safety block exactly as it ships: DEFAULT_MODE=observe,
KILL_SWITCH=false, ALLOWED_ASSET_CLASSES=equity,etf,option, and the four numeric caps.
.env.example does not yet carry the broker environment keys, so append these lines:
  TRADING_ENV=alpaca_paper
  ALPACA_API_KEY=
  ALPACA_SECRET_KEY=
Confirm .env is covered by .gitignore before writing anything sensitive into it
(`git check-ignore -v .env` must print a match).

STEP 5: ASK ME ABOUT ALPACA (one topic, wait for my answer)
Say this to me, then wait:
  "rh-trader uses Alpaca for paper trading and for all market data: quotes, bars, option
   chains, and the market clock. It needs a PAPER key pair.
   1. Sign up free at https://alpaca.markets/
   2. Open https://app.alpaca.markets/ and make sure the dashboard is on Paper Trading, not Live
   3. Generate an API key pair. The secret is shown once, copy both values now.
   Paste the key id and the secret here, or say 'skip' to set them up later."
Write my answer into .env as ALPACA_API_KEY and ALPACA_SECRET_KEY. Do not echo the secret back.
If I skip, continue: the app will start, but positions, quotes and bots will have no data.

STEP 6: ASK ME ABOUT ROBINHOOD (one topic, wait for my answer)
Say this to me, then wait:
  "Optional, and this is the real-money path. rh-trader can connect to Robinhood's agentic MCP
   endpoint. Authorizing creates a Robinhood Agentic account: a separate, isolated account that
   an agent can trade, that starts unfunded, and that you fund deliberately from the Robinhood
   app. Every other account in your Robinhood profile stays read-only to the agent, every agent
   trade sends you a push notification, and you can disconnect the agent from the Robinhood app
   at any time. It needs a primary individual investing account in good standing and a desktop
   browser.
   You can skip this now and do it any time later from Settings, Connect.
   Connect Robinhood now? yes / no"
If yes: run `npm run rh:auth` inside ./backend. It opens your browser and listens on
http://localhost:7321/callback for the redirect, then writes tokens to
backend/data/oauth-tokens.json and the oauth_tokens table (both gitignored). Tell me to complete
the authorization in the browser window, and wait for the CLI to report success.
Then tell me, and do NOT do it yourself: "Connected. The trading environment is still
alpaca_paper. Nothing will trade on Robinhood until you fund that account in the Robinhood app
and switch the environment yourself, with an explicit confirmation."
If no: continue, and mention it can be done later from Settings, Connect.

STEP 7: ASK ME ABOUT LLM PROVIDERS (one topic, wait for my answer)
Say this to me, then wait:
  "Which language model providers do you have? Any subset works, including none. Without any
   key the bots, rules, backtests, monitors and risk engine still run; research, news triage,
   Ask AI, the trade agent and the learning iterator go quiet.
   a) Groq, free tier, https://console.groq.com/keys . Fast, leads the chat and news-triage
      tasks. Free limits are 30 requests/min, 8K tokens/min and 1K requests/day per model.
   b) NVIDIA NIM, free developer tier, https://build.nvidia.com/ . Roughly 40 requests/min,
      extra fallback capacity, and the only source of embeddings for the search layer.
   c) Kimi / Moonshot, paid, https://platform.moonshot.ai/ . Strong second rung for research
      and the daily review.
   d) Anthropic, paid, https://console.anthropic.com/ . Optional. The key may be invalid; the
      router will skip it. Tell me which model id your account can use if you have one.
   e) Meta Muse Spark, https://ai.developer.meta.com/ . Leads watch, performance, and agent
      (short ops). Key goes in META_MUSE_API_KEY (aliases MUSE_API_KEY and Meta's MODEL_API_KEY).
      Default model muse-spark-1.3 (PAYG Standard). Leave META_MUSE_MODEL empty.
   f) A local OpenAI-compatible server, free. Ollama (http://localhost:11434/v1) or LM Studio
      (http://localhost:1234/v1). I will need the base URL and the exact model id the server
      returns from GET /v1/models.
   Paste the keys you want to use, and say which of these you are skipping."
Write the answers into .env only: GROQ_API_KEY, NVIDIA_API_KEY, KIMI_API_KEY,
ANTHROPIC_API_KEY plus ANTHROPIC_MODEL, META_MUSE_API_KEY (or MUSE_API_KEY / MODEL_API_KEY),
and for a local server LOCAL_BASE_URL, LOCAL_MODEL and
LOCAL_API_KEY (Ollama ignores the key value but the variable must be non-empty).
If I chose a local server, verify it is reachable and that the model id exists:
  curl -s $LOCAL_BASE_URL/models
and tell me if the id I gave is not in the list. Also tell me plainly: a small local model is
fine for news triage and acceptable for chat, but weak at tool calls and strict JSON, so keep a
hosted provider configured behind it or the agent, review and ideas tasks may fail silently.

STEP 8: BUILD AND START
Run `npm run build` in ./frontend (this produces frontend/dist, which the backend serves
itself, no Apache or MAMP needed). Then start the backend from ./backend with `npm start` and
leave it running in the background, capturing its log where you can read it.

STEP 9: VERIFY
  curl -s http://127.0.0.1:8011/api/health
Expect ok:true, db:true, env:"alpaca_paper", live:false, mode:"observe", and a broker block
where alpacaConfigured is true if I gave you Alpaca keys.
  curl -s http://127.0.0.1:8011/api/ai/models
Expect a tasks object with a resolved chain for chat, triage, research, agent, review and
ideas, and a providers object. A provider with live_ids 0 and an error string has a bad key or
base URL: tell me which one and what the error says. A provider I skipped should simply be
absent from the chains.
Then open http://127.0.0.1:8011/ in my browser.
If either check fails, show me the backend log and the exact failing response. Do not change a
safety setting to make a check pass.

STEP 10: HAND OVER
Finish by telling me, in your own words:
- The app is in PAPER mode. TRADING_ENV=alpaca_paper means orders go to the Alpaca paper
  account: fake money, real market data. The only real-money path is robinhood_live, which
  requires connecting Robinhood, funding that agentic account from the Robinhood app, and
  switching the environment with an explicit confirmation. Setup did not do any of that.
- Every bot was seeded DISABLED and in cautious mode, and the global mode is observe, which
  logs what would have happened and places nothing. Nothing trades until I enable it.
- The kill switch, on the Settings page and at POST /api/kill, blocks all new buying regardless
  of mode and still allows close-only sells, so stop-losses and take-profits keep working while
  it is engaged.
- Risk limits live in .env: MAX_POSITION_USD, MAX_PORTFOLIO_CONCENTRATION_PCT,
  MAX_DAILY_LOSS_PCT, MAX_ORDERS_PER_DAY. Cryptocurrency is blocked permanently and is not a
  setting.
- .env holds my secrets and is gitignored. Confirm that `git status --porcelain` shows no .env
  and no token file, and that nothing was committed during setup.
```
