#!/usr/bin/env bash
# Probe the paper desk API. Exit 0 only when /api/health is reachable and paper-safe.
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
  echo "dry-run: curl -fsS --max-time 3 $URL"
  echo "expect: ok/db true, live false, env alpaca_paper (paper-only desk)"
  exit 0
fi

if ! command -v curl >/dev/null 2>&1; then
  echo "health: curl is required" >&2
  exit 2
fi

BODY="$(curl -fsS --max-time 3 "$URL" 2>/dev/null || true)"
if [ -z "$BODY" ]; then
  echo "health: API not listening at $URL (503 / connection refused). Start with ./scripts/start.sh"
  exit 1
fi

# Parse with node (always present on this stack). Never echo raw body — it might grow.
export HEALTH_JSON="$BODY"
node --input-type=module <<'JS'
const d = JSON.parse(process.env.HEALTH_JSON || '{}');
const watch = d.watch || {};
console.log(`ok=${d.ok} db=${d.db} env=${d.env} live=${d.live} mode=${d.mode} kill=${d.killSwitch} listen=${d.listen || ''} pid=${d.pid || ''}`);
console.log(`watch available=${watch.available} running=${watch.running} observeOnly=${watch.observeOnly}`);
if (d.live || d.env === 'robinhood_live') {
  console.error('health: refusing — this desk must stay alpaca_paper');
  process.exit(3);
}
if (!(d.ok && d.db)) {
  console.error('health: API answered but db/ok is not true');
  process.exit(1);
}
JS

echo "health: paper desk is up"
