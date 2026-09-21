#!/usr/bin/env bash
# Probe the paper desk API. Exit 0 when /api/health is reachable and paper-safe.
# Compatible with the running Mac desk (ok/db/env/mode) AND the Monday payload
# (ready/failures/alpaca). Does not require alpaca.* — that field is additive.
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
  echo "expect: ok/db true, live false, env alpaca_paper (paper-only desk)"
  exit 0
fi

if ! command -v curl >/dev/null 2>&1; then
  echo "health: curl is required" >&2
  exit 2
fi

# Do NOT use curl -f: a 503 would collapse "MySQL down" into "API not listening".
HTTP_CODE=0
BODY="$(curl -sS --max-time 5 -w '\n%{http_code}' "$URL" 2>/tmp/rh-health-curl.err || true)"
if [ -n "$BODY" ]; then
  HTTP_CODE="$(printf '%s' "$BODY" | tail -n 1)"
  BODY="$(printf '%s' "$BODY" | sed '$d')"
fi

if [ -z "$BODY" ] || [ "$HTTP_CODE" = "000" ] || [ "$HTTP_CODE" = "0" ]; then
  echo "health: API not listening at $URL (connection refused / timeout). Start with ./scripts/start.sh or ./scripts/desk-up.sh"
  if [ -s /tmp/rh-health-curl.err ]; then sed 's/^/  /' /tmp/rh-health-curl.err; fi
  exit 1
fi

export HEALTH_JSON="$BODY"
node --input-type=module <<'JS'
const d = JSON.parse(process.env.HEALTH_JSON || '{}');
const watch = d.watch || {};
const alpaca = d.alpaca || {};
const failures = Array.isArray(d.failures) ? d.failures : [];
console.log(`ok=${d.ok} db=${d.db} env=${d.env} live=${d.live} mode=${d.mode} kill=${d.killSwitch} listen=${d.listen || ''} pid=${d.pid || ''}${d.ready != null ? ' ready=' + d.ready : ''}`);
if (alpaca.configured != null || alpaca.ok != null) {
  console.log(`alpaca configured=${alpaca.configured} ok=${alpaca.ok}${alpaca.error ? ' error=' + alpaca.error : ''}`);
}
console.log(`watch available=${watch.available} running=${watch.running} observeOnly=${watch.observeOnly} ok=${watch.ok} lastError=${watch.lastError || ''}`);
if (d.jev) {
  const j = d.jev;
  console.log(`jev ok=${j.ok} mode=${j.mode} spent=${j.spentUsd} budget=${j.budgetUsd} degraded=${j.degraded}${j.reason ? ' reason=' + j.reason : ''}`);
}
if (d.swingLaw) {
  const s = d.swingLaw;
  console.log(`swingLaw hard=${s.hardStopPct} arm=${s.gainLockArmPct} floor=${s.gainLockFloorPct} tp=${s.softTakeProfitPct} trail=${s.trailPct} dte=${s.entryDteMin}-${s.entryDteMax} leaps=${s.leapsEligible}`);
}
if (failures.length) console.log(`failures=${failures.join(',')}`);

if (d.live || d.env === 'robinhood_live') {
  console.error('health: refusing — this desk must stay alpaca_paper (do not switch to Robinhood live)');
  process.exit(3);
}
if (!d.db || d.ok === false || failures.includes('db_down') || failures.includes('db_read_failed')) {
  console.error('health: MySQL is down or unreadable. Check MAMP :8889 and .env DB_* (ulric_rhtrader).');
  process.exit(1);
}
JS

echo "health: paper desk is up"
