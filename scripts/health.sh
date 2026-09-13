#!/usr/bin/env bash
# Probe the paper desk API. Exit 0 only when /api/health is reachable and paper-ready.
# Distinguishes: API not listening vs MySQL down vs Alpaca down vs live env.
# Usage: ./scripts/health.sh [--dry-run] [--url URL]
set -euo pipefail
URL="http://127.0.0.1:8011/api/health"
DRY=0
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY=1; shift ;;
    --url) URL="$2"; shift 2 ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done

if [ "$DRY" = 1 ]; then
  echo "dry-run: curl --max-time 5 $URL  (HTTP 200 even when db/alpaca are down)"
  echo "expect: ready=true db=true env=alpaca_paper live=false paper=true alpaca.ok=true"
  echo "fail-closed: db_down / alpaca_not_configured / alpaca_unreachable / live_env"
  exit 0
fi

if ! command -v curl >/dev/null 2>&1; then
  echo "health: curl is required" >&2
  exit 2
fi

# Do NOT use curl -f: /api/health is always 200 with a body when the process is up.
# -f would collapse "MySQL down" into "API not listening".
HTTP_CODE=0
BODY="$(curl -sS --max-time 5 -w '\n%{http_code}' "$URL" 2>/tmp/rh-health-curl.err || true)"
if [ -n "$BODY" ]; then
  HTTP_CODE="$(printf '%s' "$BODY" | tail -n 1)"
  BODY="$(printf '%s' "$BODY" | sed '$d')"
fi

if [ -z "$BODY" ] || [ "$HTTP_CODE" = "000" ] || [ "$HTTP_CODE" = "0" ]; then
  echo "health: API not listening at $URL (connection refused / timeout). Start with ./scripts/start.sh"
  if [ -s /tmp/rh-health-curl.err ]; then sed 's/^/  /' /tmp/rh-health-curl.err; fi
  exit 1
fi

export HEALTH_JSON="$BODY"
node --input-type=module <<'JS'
const d = JSON.parse(process.env.HEALTH_JSON || '{}');
const watch = d.watch || {};
const alpaca = d.alpaca || {};
const failures = Array.isArray(d.failures) ? d.failures : [];
console.log(`ok=${d.ok} ready=${d.ready} db=${d.db} env=${d.env} live=${d.live} paper=${d.paper} mode=${d.mode} kill=${d.killSwitch} listen=${d.listen || ''} pid=${d.pid || ''}`);
console.log(`alpaca configured=${alpaca.configured} ok=${alpaca.ok}${alpaca.error ? ' error=' + alpaca.error : ''}${alpaca.status ? ' status=' + alpaca.status : ''}`);
console.log(`watch available=${watch.available} running=${watch.running} observeOnly=${watch.observeOnly}`);
if (failures.length) console.log(`failures=${failures.join(',')}`);

if (d.live || d.env === 'robinhood_live') {
  console.error('health: refusing — this desk must stay alpaca_paper (do not switch to Robinhood live)');
  process.exit(3);
}
if (!d.db || failures.includes('db_down') || failures.includes('db_read_failed')) {
  console.error('health: MySQL is down or unreadable. Check MAMP :8889 and .env DB_* (database must be ulric_rhtrader, not rh_tradingbot).');
  process.exit(1);
}
if (failures.includes('alpaca_not_configured') || alpaca.configured === false) {
  console.error('health: Alpaca paper keys missing. Set ALPACA_API_KEY + ALPACA_SECRET_KEY in .env (paper keys only).');
  process.exit(4);
}
if (failures.includes('alpaca_unreachable') || alpaca.ok === false) {
  console.error('health: Alpaca paper unreachable. ' + (alpaca.error || 'Check keys, paper-api.alpaca.markets, and network.'));
  process.exit(4);
}
if (d.ready === false) {
  console.error('health: API answered but ready is false — ' + (failures.join(',') || 'unknown'));
  process.exit(1);
}
JS

echo "health: paper desk is ready (alpaca_paper)"
