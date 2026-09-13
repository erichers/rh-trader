# Monday paper test (Alpaca only)

Stay on **Alpaca paper**. Do not switch `TRADING_ENV` to Robinhood live. Do not place real-money orders.

**Arm in `full_auto`.** Same-symbol book ($10k) and 25% concentration are hard rails in `full_auto` (they used to be bypassed — that is the META stack bug). The only remaining `full_auto` skip is the 40-orders/day throttle. Kill switch and the 50% daily breaker still stop a runaway.

Risk law: **$10k max per trade / same-symbol book**, **50% daily drawdown breaker**. Kill switch still blocks new buys (exits stay on).

## Boot

On the Mac (paper keys + MySQL already in `.env`, `DB_NAME=ulric_rhtrader`):

```bash
cd /Users/eric/Sites/rh.tradingbot   # or grokbot/grokbot-rh-trader if you parked it
# confirm you are NOT creating a rh_tradingbot schema
grep DB_NAME .env                    # must be ulric_rhtrader

./scripts/stop.sh
./scripts/start.sh --build
./scripts/health.sh
```

Expect:

```
ok=true ready=true db=true env=alpaca_paper live=false paper=true
alpaca configured=true ok=true
```

UI: `http://127.0.0.1:8011/` (or MAMP `http://localhost:8888/rh.tradingbot/`). Trust `/api/health`, not the static HTML shell.

| If this fails | Cause | Do this |
| --- | --- | --- |
| `API not listening` | Node not on `:8011` | `./scripts/start.sh` then tail `/tmp/rh-trader-backend.log` |
| `db_down` | MAMP MySQL or wrong DB | Start MAMP (`:8889`). `.env` `DB_NAME=ulric_rhtrader` |
| `alpaca_not_configured` | Missing paper keys | Set `ALPACA_API_KEY` + `ALPACA_SECRET_KEY` (paper, not live) |
| `alpaca_unreachable` | Keys / network / Alpaca | Check paper dashboard + `paper-api.alpaca.markets` |
| `live_env` / `refusing` | Env flipped to Robinhood | Switch back to **Paper (Alpaca)** immediately |

## Arm

1. Confirm the top-bar badge is **PAPER · Alpaca** (not LIVE).
2. Kill switch **off**.
3. Set **each enabled trading bot** to **full** (the engine uses the bot's own mode, not only the top-bar global). Book/concentration still bind.
4. Top-bar global mode **Full-Auto** (covers manual / AI drafts).
5. Leave the three watch stubs enabled if you want signals: **Mean-Revert Watch**, **Quiet Range Scout**, **Vol-Regime MR**. They must stay watch-only even if someone flips them to full_auto.
6. Enable only the bots you intend to watch (Donchian / Momentum Day / Opening Range are the META-stack trio).
7. Optional: `POST /api/bots/:id/evaluate` once after the open to force a pass.

## Watch

- **Orders**: no `draft` / `staged` / `placed` / `vetoed` rows from the three watch stubs. Signals may log; that is not an order.
- **Same name**: if Donchian + Momentum + ORB fire on one symbol in **full_auto**, the third ticket must **veto** on symbol book / concentration, not pass as another $10k ticket.
- **Kill**: flip **KILL SWITCH**. New buys stop. Open exits (TP/SL/trail) still flatten.
- Sidebar: API green, DB green, Alpaca green. If any go red/amber, do not keep arming.

## Kill switch

1. Top-bar **KILL SWITCH** (or Settings). Engaged = no new buys.
2. `./scripts/stop.sh` — API gone; MAMP HTML may still render. The amber **API down** banner must show.
3. Do not flip the env dropdown to Live.

## Success criteria for merging PR #6 / PR #8

A watched paper session counts when **all** of these are true:

- [ ] `./scripts/health.sh` printed `ready=true` `env=alpaca_paper` `live=false` `alpaca ok=true` before the open.
- [ ] Watch stubs (if enabled) produced **zero** order rows (draft/stage/place/veto).
- [ ] A same-symbol stack that would exceed **$10k** (or 25% of equity) was **vetoed** in **`full_auto`**.
- [ ] Kill switch stopped new buys; you could still flatten.
- [ ] No one switched to Robinhood live. No real-money order left the box.
- [ ] Session ran **`full_auto`**. Book/concentration held. Orders/day may have been skipped — that is the only remaining bypass.

If any box fails, **do not merge**. Fix on this harden line and run another paper session.
