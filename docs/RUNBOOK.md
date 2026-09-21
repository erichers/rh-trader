# Paper desk runbook

Stay on **Alpaca paper**. Do not switch `TRADING_ENV` to `robinhood_live` from these scripts.

Monday one-pager (full_auto arm, $10k / 50% rails, Mac stash instructions): [`MONDAY-PAPER-TEST.md`](./MONDAY-PAPER-TEST.md).

## Jev entry and exit (paper)

Models → Jev can advise an entry (enter, skip, size down) and, when you turn that bot's exit scope on, an open option (CLOSE, PARTIAL, HOLD, or TIGHTEN_TRAIL). It is not a price predictor. Global mode is still off, shadow, or active. Each bot stores `risk.jev = { entry: false, exit: false }` until you enable a scope. Jev changes a paper order only when global mode is active, that scope is on, and the account is Alpaca paper. Otherwise it logs the decision and stands down.

The hard stop, gain-lock floor (+1.5%), and trail run first. A Jev hold, size down, partial, or tighten cannot clear a stop or the gain-lock, and cannot widen the hard stop past −10%. CLOSE and PARTIAL only sell. They never add size. Exit checks use the same DTE bands health already shows: 0 to 3 DTE about every 5 minutes, 4 to 14 DTE about every 20 minutes, 15 to 179 DTE about every hour, and 180 DTE and out about every 4 hours. A fresh decision inside that window does not call TypeSafe again. Outside regular hours, or when TypeSafe returns 503, the exit panel logs and does not sell. Per-bot exit stays off until you turn it on, and still logs, including when a hard rail already owns the sell. The $5 budget still applies. Wave-1 candidates are bots 89, 12, 86, 25, 21, 39, 91, and 92. They stay off until you turn exit on. 0-DTE, the Mag-7 fleet, covered-call observe, and speculative LEAPS cannot arm exit. The Bots list has Entry Jev and Exit Jev columns. Exit defaults off and still logs. A desk-health line under the paper badge shows Ready (or the first failure), Exits armed, Jev mode, and Muse mode. It stays up when the sidebar collapses. Open longs show an exit pulse from the swing law. A stuck sell is red.

Connect Robinhood is hidden while the desk is Alpaca paper. The top-bar live switch still asks in the UI, and the API still requires `confirm: true`.

Pull on the Mac desk:

```bash
cd /Users/eric/Sites/grokbot/grokbot-rh-trader
git fetch origin
git checkout cursor/jev-exit-per-bot-2a56
git pull --ff-only origin cursor/jev-exit-per-bot-2a56
./scripts/start.sh
```

UI: `http://localhost:8888/grokbot/grokbot-rh-trader/#/models/jev`

## What must be up

| Piece | Address | If it is down |
| --- | --- | --- |
| Backend API | `http://127.0.0.1:8011/api/health` | Bots, quotes, Muse/watch lamps, and the React app (when served by Fastify) all fail. The MAMP static shell at `:8888` can still show HTML. |
| MySQL | `.env` `DB_HOST` / `DB_PORT` (MAMP often `127.0.0.1:8889`, database `ulric_rhtrader` or `rh_tradingbot`) | Health returns `db: false`. |
| Frontend | Fastify serves `frontend/dist` on `:8011`, or Vite on `:5173`, or MAMP `http://localhost:8888/grokbot/grokbot-rh-trader/` | Rebuild with `./scripts/start.sh --build`. |

## Mac desk (author's machine)

Checkout lives at **`/Users/eric/Sites/grokbot/grokbot-rh-trader`**. That is a folder inside the grokbot Sites root, not the grokbot decks tree and not `grokbot-app`.

```bash
# Move /Users/eric/Sites/rh.tradingbot here if needed, wire MAMP, start paper,
# arm backtest winners, open the browser:
./scripts/desk-up.sh
```

- UI: `http://localhost:8888/grokbot/grokbot-rh-trader/` (compat: `http://localhost:8888/rh.tradingbot/`)
- API: `http://127.0.0.1:8011`
- DB: MAMP MySQL `:8889`

`./scripts/paper-trade.sh` scans backtests, enables winners on **Alpaca paper** in **full_auto**, and leaves watch stubs observe-only. It refuses if health is `robinhood_live`. Book/concentration still bind in full_auto.

## Bring the stack up

```bash
# Mac: install under grokbot, MAMP, paper arm, open browser
./scripts/desk-up.sh

# API only (Linux, CI, or a Mac without MAMP):
./scripts/start.sh

# API + SPA build, then optional MAMP Apache:
./scripts/run-web.sh

# Hot reload (backend tsx watch + Vite :5173):
./scripts/dev.sh
```

`start.sh` writes `/tmp/rh-trader-backend.log` and `/tmp/rh-trader-backend.pid`. A crash respawns after 3 seconds unless you pass `--no-respawn`.

## Health / stop

```bash
./scripts/health.sh            # exit 0 only if API is up, db ok, and env is paper
./scripts/health.sh --dry-run  # prints the probe, does not call the network
./scripts/stop.sh              # SIGTERM the pid file, then leftover tsx
./scripts/start.sh --dry-run
./scripts/stop.sh --dry-run
./scripts/run-web.sh --dry-run
```

Expect `/api/health` JSON with `ok`/`db` true, `env: "alpaca_paper"`, `live: false`, `paper: true`, and a `watch` block. The payload never includes API keys.

## Historical local path

The desk used to live at `/Users/eric/Sites/rh.tradingbot`. `./scripts/install-mac-grokbot.sh` moves that folder to `/Users/eric/Sites/grokbot/grokbot-rh-trader` (and will also pick up a misnamed `grokbot/rh-trader` or sibling `Sites/grokbot-rhtrader`) and keeps the old MAMP alias as a bookmark.

The static Apache shell can look "up" while the API is a 503. Trust the red **API down** banner and `./scripts/health.sh`, not the HTML shell.

## Observe-only stubs

Mean-Revert Watch, Quiet Range Scout, and Vol-Regime MR are watch stubs. They may be enabled for signals, but they must never place, stage, draft-as-trade, or write a veto row. The engine gate is in `execute.ts` and does not trust `enabled` or bot mode.

## Same-symbol stacking

Auto still respects the kill switch, the daily-loss breaker (clamped at 50%), and max orders/day (40). Max position and 25% concentration apply to the **combined** book on one symbol across bots, not only the ticket in hand.
