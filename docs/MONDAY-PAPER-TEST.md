# Monday paper test (Alpaca only)

Stay on **Alpaca paper**. Do not switch `TRADING_ENV` to Robinhood live.

**Arm in `full_auto`.** Same-symbol book ($10k) and 25% concentration are hard rails in `full_auto` (PR #6 used to bypass those as “soft sizing”). The only remaining `full_auto` skip is the 40-orders/day throttle. Kill switch and the **50%** daily breaker still stop a runaway.

Risk law: **$10k max per trade / same-symbol book**, **50% daily drawdown breaker**.

Swing law (enforced in `exitpolicy.ts` + the live monitor — full_auto closes without a human):

- Hard stop **−10%** from entry
- Gain-lock arms at **+10%**, floor **0** (breakeven)
- Soft take-profit goal **~25%** (close when hit *or* trail keeps riding; trail **12**)
- Never **0DTE/1DTE**; entry window **2–14 DTE** (LEAPS excepted)
- No overnight / no weekend holds except **LEAPS** bots

Exit lifecycle (Monday live bugs):

- Monitor stays **open** until the broker reports a **filled** exit. `new` / `placed` is pending (NVDA #203 / order 7117001).
- Stuck `new` sells: cancel after 90s, retry up to 3 attempts, then escalate. No close-on-place.
- `held=0` + flat book → **orphan once**. No trailing-stop spam (`sell N > held 0`).
- Unprotected longs (open position, no open monitor) get a swing-law monitor re-attached.
- Corrupt `exit_policy` JSON is rewritten to `{ holdOvernight: false, holdOverWeekend: false, closeBufferMin: 15 }`.

Mac checkout: **`/Users/eric/Sites/grokbot/grokbot-rh-trader`** (PR #7 path). UI `http://localhost:8888/grokbot/grokbot-rh-trader/` or `http://127.0.0.1:8011/`.

## Mac merge — do not overwrite local uncommitted work

Eric’s Cursor session may have **uncommitted** desk UI on `cursor/grokbot-sites-paper-ceaa` (DeskLive, OpenBook, bots/engine, frontend views, maybe a local `exitpolicy` / `swingprofile`). **Do not** `git reset --hard`, `git checkout --`, or `git clean` those files.

```bash
cd /Users/eric/Sites/grokbot/grokbot-rh-trader
git status                                 # confirm your dirty files
git stash push -u -m "eric-desk-local-$(date +%Y%m%d)"
git fetch origin
# This swing-rails branch sits on PR #9 (monday-grokbot-paper-b394):
git checkout cursor/full-auto-swing-rails-f918
git stash pop                              # keep YOUR side on desk-view conflicts
```

If `stash pop` conflicts:

- `frontend/**`, `DeskLive`, `OpenBook`, `bots/engine.ts` — **keep yours**
- `backend/src/risk/engine.ts` — keep Eric’s other hunks **and** keep `applyFullAutoSoftBypass` (book/concentration stay hard) plus `checks.entry_dte`
- `backend/src/risk/exitpolicy.ts` — keep the locked constants: `HARD_STOP_PCT=10`, `GAIN_LOCK_ARM_PCT=10`, `GAIN_LOCK_FLOOR_PCT=0`, `SOFT_TAKE_PROFIT_PCT=25`. Merge any extra local swing notes around them; do not restore the old +30% / +1% lock
- `backend/src/risk/monitor.ts` — keep `overnightFlattenReason` / LEAPS exception and `exitReason(...)` as the only exit ladder

### Files this follow-up touches vs likely local work

| Path | This follow-up | Local risk |
| --- | --- | --- |
| `backend/src/risk/exitpolicy.ts` | swing law constants + `exitReason` + overnight helper | **likely conflict** — keep −10 / +10 / 0 / ~25 |
| `backend/src/risk/dte.ts` | **new** — 2–14 DTE gate | no conflict |
| `backend/src/risk/monitor.ts` | swing defaults; LEAPS-only overnight | possible |
| `backend/src/risk/engine.ts` | additive `entry_dte` check | possible — keep book rails + DTE check |
| `backend/src/db.ts` | factory defaults sl=10 / tp=25 / trail=20 | possible if you edited limits |
| `bots/engine.ts` | **untouched** | keep yours |
| `swingprofile` / `DeskLive` / `OpenBook` | **not in this PR** | keep yours |
| frontend desk views (`App.tsx`, Bots, …) | **untouched** | keep yours |

PR #9 (`cursor/monday-grokbot-paper-b394`) is the Monday gates only. **This branch is PR #9 + swing law.** Prefer this one on the Mac for the live session.

## Boot (stack already up)

```bash
cd /Users/eric/Sites/grokbot/grokbot-rh-trader
./scripts/health.sh
# expect ok=true db=true env=alpaca_paper live=false mode=full_auto
# /api/health now also has swingLaw { hardStopPct:10, gainLockArmPct:10, gainLockFloorPct:0, softTakeProfitPct:25 }
# do NOT run desk-up.sh / paper-trade.sh if that would rebuild over dirty files
```

If you need a restart after merging this branch: `./scripts/stop.sh && ./scripts/start.sh` (API only). Avoid `desk-up.sh` until local work is committed or stashed.

## Arm

1. Badge **PAPER · Alpaca**. Kill **off**.
2. Each enabled **trading** bot mode **full** (engine uses the bot’s mode). Global **Full-Auto**.
3. Watch stubs (Mean-Revert Watch, Quiet Range Scout, Vol-Regime MR) may stay enabled — they must not create order rows even on `full_auto`.
4. If you re-run `POST /api/paper/arm-from-backtests`, winners arm `full_auto`.

## Watch

- No draft/stage/place/veto from watch stubs.
- Donchian + Momentum + ORB on one name in **full_auto**: third ticket **vetoes** on $10k book or 25% concentration.
- 0DTE / 1DTE option buys **veto**. Weekly/monthly resolve inside 2–14 DTE.
- A position that prints −10% from entry should auto-exit (`stop-loss`). A +10% peak that fades to 0 should `gain-lock`.
- A working Alpaca sell still `new` must **not** close the monitor. NVDA/SPY-style stuck exits cancel+retry or escalate.
- Flat META/GOOGL: one orphan, zero extra veto rows.
- Every open long has an open monitor (`swingLaw` sl 10 / trail 12 / tp 25).
- Kill switch: new buys stop; exits still flatten. Non-LEAPS flatten before the close.

## Success

- [ ] Health still `env=alpaca_paper` `live=false` `mode=full_auto` after the merge (Eric’s local desk views still load).
- [ ] Watch stubs: zero order rows.
- [ ] Same-symbol stack over $10k (or 25% equity) vetoed in **full_auto**.
- [ ] 0DTE buy blocked. Loser cut / winner trail without waiting for a human.
- [ ] Kill switch worked. No Robinhood live. No `git reset --hard` of local work.

If any box fails, **do not merge**.
