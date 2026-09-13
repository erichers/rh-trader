# Paper desk runbook

Stay on **Alpaca paper**. Do not switch `TRADING_ENV` to `robinhood_live` from these scripts.

Monday one-pager: [`MONDAY-PAPER-TEST.md`](./MONDAY-PAPER-TEST.md).

## What must be up

| Piece | Address | If it is down |
| --- | --- | --- |
| Backend API | `http://127.0.0.1:8011/api/health` | Bots, quotes, Muse/watch lamps, and the React app (when served by Fastify) all fail. The MAMP static shell at `:8888` can still show HTML. |
| MySQL | `.env` `DB_HOST` / `DB_PORT` (MAMP often `127.0.0.1:8889`, database **`ulric_rhtrader`**) | Health returns `db: false` and `failures` includes `db_down`. Do not create `rh_tradingbot`. |
| Alpaca paper | `/api/health` → `alpaca.ok` | Health returns `alpaca_not_configured` or `alpaca_unreachable`. Do not arm bots. |
| Frontend | Fastify serves `frontend/dist` on `:8011`, or Vite on `:5173`, or optional MAMP `http://localhost:8888/rh.tradingbot/` | Rebuild with `./scripts/start.sh --build`. |

## Bring the stack up

```bash
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
./scripts/health.sh            # exit 0 only if API is up, db ok, Alpaca reachable, env is paper
./scripts/health.sh --dry-run  # prints the probe, does not call the network
./scripts/stop.sh              # SIGTERM the pid file, then leftover tsx
./scripts/start.sh --dry-run
./scripts/stop.sh --dry-run
./scripts/run-web.sh --dry-run
```

Expect `/api/health` JSON with `ok`/`db`/`ready` true, `env: "alpaca_paper"`, `live: false`, `paper: true`, `alpaca.ok: true`, and a `watch` block. The payload never includes API keys. HTTP status is 200 even when MySQL or Alpaca is down — read `failures[]`.

## Historical local path (author's Mac)

- UI: `http://localhost:8888/rh.tradingbot/`
- API: `http://127.0.0.1:8011`
- DB: MAMP MySQL `:8889`, database **`ulric_rhtrader`** (never `rh_tradingbot`)

The static Apache shell can look "up" while the API is a 503. Trust the red **API down** banner and `./scripts/health.sh`, not the HTML shell.

## Observe-only stubs

Mean-Revert Watch, Quiet Range Scout, and Vol-Regime MR are watch stubs. They may be enabled for signals, but they must never place, stage, draft-as-trade, or write a veto row. The engine gate is in `execute.ts` and does not trust `enabled` or bot mode.

## Same-symbol stacking — auto vs full_auto

Hard in **both** `auto` and `full_auto`:

- kill switch (new buys)
- no-crypto / long-only / no naked write
- daily-loss breaker (clamped at **50%**)
- per-ticket and same-symbol book (**$10k** risk law)
- 25% concentration vs equity

`full_auto` still bypasses **only** the max-orders/day throttle (40). Monday's watched session arms **`full_auto`**; book and concentration still bind.
