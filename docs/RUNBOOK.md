# Paper desk runbook

Stay on **Alpaca paper**. Do not switch `TRADING_ENV` to `robinhood_live` from these scripts.

## What must be up

| Piece | Address | If it is down |
| --- | --- | --- |
| Backend API | `http://127.0.0.1:8011/api/health` | Bots, quotes, Muse/watch lamps, and the React app (when served by Fastify) all fail. The MAMP static shell at `:8888` can still show HTML. |
| MySQL | `.env` `DB_HOST` / `DB_PORT` (MAMP often `127.0.0.1:8889`, database `ulric_rhtrader` or `rh_tradingbot`) | Health returns `db: false`. |
| Frontend | Fastify serves `frontend/dist` on `:8011`, or Vite on `:5173`, or MAMP `http://localhost:8888/grokbot/rh-trader/` | Rebuild with `./scripts/start.sh --build`. |

## Mac desk (author's machine)

Checkout lives at **`/Users/eric/Sites/grokbot/rh-trader`**. That is a folder inside the grokbot Sites root, not the grokbot decks tree and not `grokbot-app`.

```bash
# Move /Users/eric/Sites/rh.tradingbot here if needed, wire MAMP, start paper,
# arm backtest winners, open the browser:
./scripts/desk-up.sh
```

- UI: `http://localhost:8888/grokbot/rh-trader/` (compat: `http://localhost:8888/rh.tradingbot/`)
- API: `http://127.0.0.1:8011`
- DB: MAMP MySQL `:8889`

`./scripts/paper-trade.sh` scans backtests, Auto-enables winners on **Alpaca paper**, and leaves watch stubs observe-only. It refuses if health is `robinhood_live`.

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

The desk used to live at `/Users/eric/Sites/rh.tradingbot`. `./scripts/install-mac-grokbot.sh` moves that folder to `/Users/eric/Sites/grokbot/rh-trader` and keeps the old MAMP alias as a bookmark.

The static Apache shell can look "up" while the API is a 503. Trust the red **API down** banner and `./scripts/health.sh`, not the HTML shell.

## Observe-only stubs

Mean-Revert Watch, Quiet Range Scout, and Vol-Regime MR are watch stubs. They may be enabled for signals, but they must never place, stage, draft-as-trade, or write a veto row. The engine gate is in `execute.ts` and does not trust `enabled` or bot mode.

## Same-symbol stacking

Auto still respects the kill switch, the daily-loss breaker (clamped at 50%), and max orders/day (40). Max position and 25% concentration apply to the **combined** book on one symbol across bots, not only the ticket in hand.
