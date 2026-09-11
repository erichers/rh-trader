#!/usr/bin/env bash
# After the paper desk API is up: learn from backtests and Auto-enable winners.
# Alpaca paper only. Refuses if /api/health is live/robinhood.
set -euo pipefail
URL="${RH_API_URL:-http://127.0.0.1:8011}"
DRY=0
[ "${1:-}" = "--dry-run" ] && DRY=1

echo "▸ paper-trade — arm winners from backtests (never live)"

if [ "$DRY" = 1 ]; then
  echo "dry-run: curl $URL/api/health (must be alpaca_paper, live=false)"
  echo "dry-run: POST $URL/api/paper/arm-from-backtests"
  echo "dry-run: POST $URL/api/learning/run {kind:daily} (non-fatal if skipped)"
  exit 0
fi

BODY="$(curl -fsS --max-time 5 "$URL/api/health" 2>/dev/null || true)"
if [ -z "$BODY" ]; then
  echo "paper-trade: API not up. Start with ./scripts/start.sh or ./scripts/desk-up.sh" >&2
  exit 1
fi
export HEALTH_JSON="$BODY"
node --input-type=module <<'JS'
const d = JSON.parse(process.env.HEALTH_JSON || '{}');
if (d.live || d.env === 'robinhood_live') {
  console.error('paper-trade: refusing — health is not Alpaca paper');
  process.exit(3);
}
if (!(d.ok && d.db)) {
  console.error('paper-trade: API up but db/ok is not true');
  process.exit(1);
}
console.log(`health env=${d.env} live=${d.live} mode=${d.mode}`);
JS

echo "▸ POST /api/paper/arm-from-backtests"
ARM="$(curl -fsS --max-time 180 -H 'content-type: application/json' \
  -d '{}' "$URL/api/paper/arm-from-backtests" || true)"
if [ -z "$ARM" ]; then
  echo "paper-trade: arm-from-backtests failed (timeout or HTTP error). Check /tmp/rh-trader-backend.log" >&2
  exit 1
fi
export ARM_JSON="$ARM"
node --input-type=module <<'JS'
const d = JSON.parse(process.env.ARM_JSON || '{}');
if (d.error) {
  console.error('paper-trade:', d.error);
  process.exit(1);
}
const n = (a) => Array.isArray(a) ? a.length : 0;
console.log(`armed=${n(d.armed)} watching=${n(d.watching)} skipped=${n(d.skipped)} mode=${d.global_mode}`);
for (const row of d.armed || []) console.log(`  trade  #${row.bot_id} ${row.name} — ${row.reason}`);
for (const row of d.watching || []) console.log(`  watch  #${row.bot_id} ${row.name}`);
JS

echo "paper-trade: desk is in Alpaca paper Auto for backtest winners"
echo "paper-trade: UI  http://127.0.0.1:8011/   or  http://localhost:8888/grokbot/rh-trader/"
