# Monday paper test (Alpaca only)

Stay on **Alpaca paper**. Do not switch `TRADING_ENV` to Robinhood live.

**Arm in `full_auto`.** Same-symbol book ($10k) and 25% concentration are hard rails in `full_auto` (PR #6 used to bypass those as “soft sizing”). The only remaining `full_auto` skip is the 40-orders/day throttle. Kill switch and the **50%** daily breaker still stop a runaway.

Risk law: **$10k max per trade / same-symbol book**, **50% daily drawdown breaker**.

Mac checkout: **`/Users/eric/Sites/grokbot/grokbot-rh-trader`** (PR #7 path). UI `http://localhost:8888/grokbot/grokbot-rh-trader/` or `http://127.0.0.1:8011/`.

## Mac merge — do not overwrite local uncommitted work

Eric’s Cursor session has **uncommitted** edits on `cursor/grokbot-sites-paper-ceaa` (exitpolicy, swingprofile, DeskLive, OpenBook, bots/engine, risk/engine, frontend desk views). **Do not** `git reset --hard`, `git checkout --`, or `git clean` those files.

```bash
cd /Users/eric/Sites/grokbot/grokbot-rh-trader
git status                                 # confirm your dirty files
git stash push -u -m "eric-desk-local-$(date +%Y%m%d)"
git fetch origin
git checkout cursor/monday-grokbot-paper-b394
git stash pop                              # keep YOUR side on desk-view conflicts
```

If `stash pop` conflicts in `backend/src/risk/engine.ts`, keep Eric’s local logic **and** keep these rails (the only Monday-required hunks):

- `applyFullAutoSoftBypass` — `sizeOk` / `concentrationOk` must **not** flip true just because `mode === 'full_auto'`
- `RISK_LAW.maxTradeUsd === 10000`, `maxDailyDrawdownPct === 50`

### Files this PR touches vs likely local work

| Path | This PR | Local risk |
| --- | --- | --- |
| `backend/src/risk/exitpolicy.ts` | **untouched** | keep yours |
| `bots/engine.ts` | **untouched** | keep yours |
| `swingprofile` / `DeskLive` / `OpenBook` | **not in this PR** | keep yours |
| frontend desk views (`App.tsx`, Bots, …) | **untouched** | keep yours |
| `backend/src/risk/engine.ts` | surgical: full_auto no longer bypasses book/concentration; $10k/$50% clamp | **likely conflict** — merge rails in, keep your other hunks |
| `backend/src/db.ts` | clamp get/set risk limits to $10k / 50% | possible if you edited limits |
| `backend/src/routes/api.ts` | `/api/health` only (same ok/db/ai/env/mode/paper fields + additive `ready`/`alpaca`/`failures`) | possible if you edited routes |
| `backend/src/paperArm.ts` | winners arm `full_auto` (was `auto`) | low unless you edited arm |
| `backend/src/risk/law.ts`, `health.ts`, `*.test.ts` | **new files** | no conflict |
| `docs/MONDAY-PAPER-TEST.md` | **new** | no conflict |

PR #8 (`cursor/monday-paper-desk-b394`) was the same gates on the PR #6 base (no grokbot path). **This PR is the one to pull on the Mac** — it starts from PR #7.

## Boot (stack already up)

Your last health was already good: `ok` `db` `ai`, `env=alpaca_paper`, `mode=full_auto`, `killSwitch=false`, `paper=true`, `listen 127.0.0.1:8011`.

```bash
cd /Users/eric/Sites/grokbot/grokbot-rh-trader
./scripts/health.sh
# expect ok=true db=true env=alpaca_paper live=false mode=full_auto
# do NOT run desk-up.sh / paper-trade.sh if that would rebuild over dirty files
```

If you need a restart after merging this branch: `./scripts/stop.sh && ./scripts/start.sh` (API only). Avoid `desk-up.sh` until local work is committed or stashed.

## Arm

1. Badge **PAPER · Alpaca**. Kill **off**.
2. Each enabled **trading** bot mode **full** (engine uses the bot’s mode). Global **Full-Auto**.
3. Watch stubs (Mean-Revert Watch, Quiet Range Scout, Vol-Regime MR) may stay enabled — they must not create order rows even on `full_auto`.
4. If you re-run `POST /api/paper/arm-from-backtests`, this branch sets winners to `full_auto` (PR #7 used `auto`).

## Watch

- No draft/stage/place/veto from watch stubs.
- Donchian + Momentum + ORB on one name in **full_auto**: third ticket **vetoes** on $10k book or 25% concentration.
- Kill switch: new buys stop; exits still flatten.

## Success (merge of #6 / #7 / this PR)

- [ ] Health still `env=alpaca_paper` `live=false` `mode=full_auto` after the merge (Eric’s local desk views still load).
- [ ] Watch stubs: zero order rows.
- [ ] Same-symbol stack over $10k (or 25% equity) vetoed in **full_auto**.
- [ ] Kill switch worked. No Robinhood live. No `git reset --hard` of local work.

If any box fails, **do not merge**.
