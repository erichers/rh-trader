#!/usr/bin/env bash
# Bring the paper desk API up on 127.0.0.1:8011.
# Does not switch TRADING_ENV, does not touch Robinhood, does not print secrets.
# Usage: ./scripts/start.sh [--dry-run] [--no-respawn] [--build]
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PID_FILE="${RH_PID_FILE:-/tmp/rh-trader-backend.pid}"
LOG_FILE="${RH_LOG_FILE:-/tmp/rh-trader-backend.log}"
PORT="${PORT:-8011}"
DRY=0
RESPAWN=1
BUILD=0
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY=1; shift ;;
    --no-respawn) RESPAWN=0; shift ;;
    --build) BUILD=1; shift ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done

echo "▸ paper desk start (API http://127.0.0.1:${PORT}  log $LOG_FILE)"
echo "▸ TRADING_ENV stays alpaca_paper — this script never flips to live"

if [ "$DRY" = 1 ]; then
  echo "dry-run: test -d $ROOT/backend"
  echo "dry-run: require node + npm; optional mysql"
  echo "dry-run: ./scripts/stop.sh then nohup backend (respawn=$RESPAWN build=$BUILD)"
  echo "dry-run: wait for ./scripts/health.sh"
  exit 0
fi

if ! command -v node >/dev/null 2>&1; then
  echo "start: node is required (22+)" >&2
  exit 2
fi
if ! command -v npm >/dev/null 2>&1; then
  echo "start: npm is required" >&2
  exit 2
fi

if [ ! -d "$ROOT/backend/node_modules" ]; then
  echo "▸ npm install (backend)"
  ( cd "$ROOT/backend" && npm install )
fi
if [ "$BUILD" = 1 ]; then
  if [ ! -d "$ROOT/frontend/node_modules" ]; then
    echo "▸ npm install (frontend)"
    ( cd "$ROOT/frontend" && npm install )
  fi
  echo "▸ building SPA → frontend/dist"
  ( cd "$ROOT/frontend" && npm run build )
fi

"$ROOT/scripts/stop.sh" || true
mkdir -p "$(dirname "$LOG_FILE")"
: > "$LOG_FILE"

# Respawn loop: crash → 3s → start again. SIGTERM/SIGINT from stop.sh ends the loop.
if [ "$RESPAWN" = 1 ]; then
  nohup bash -c "
    trap 'exit 0' TERM INT
    cd '$ROOT/backend'
    while true; do
      echo \"[\$(date -Iseconds)] backend starting (paper)\" >> '$LOG_FILE'
      npm start >> '$LOG_FILE' 2>&1
      code=\$?
      echo \"[\$(date -Iseconds)] backend exited \$code — respawn in 3s\" >> '$LOG_FILE'
      sleep 3
    done
  " >/dev/null 2>&1 &
  echo $! > "$PID_FILE"
else
  nohup bash -c "cd '$ROOT/backend' && npm start >> '$LOG_FILE' 2>&1" >/dev/null 2>&1 &
  echo $! > "$PID_FILE"
fi

echo "▸ waiting for health on :${PORT}…"
ok=0
for i in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15; do
  if "$ROOT/scripts/health.sh" >/dev/null 2>&1; then ok=1; break; fi
  sleep 1
done

if [ "$ok" != 1 ]; then
  echo "start: health check failed. Last log lines:"
  tail -n 40 "$LOG_FILE" || true
  echo "start: common causes — MySQL down, bad .env DB_*, port in use, missing npm install"
  exit 1
fi

echo "start: API is up  http://127.0.0.1:${PORT}/"
echo "start: health     http://127.0.0.1:${PORT}/api/health"
echo "start: log        $LOG_FILE"
echo "start: stop       ./scripts/stop.sh"
echo "start: MAMP shell (optional) http://localhost:8888/grokbot/rh-trader/"
