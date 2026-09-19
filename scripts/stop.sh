#!/usr/bin/env bash
# Stop the Node backend (and optional Vite) started by start.sh / run-web.sh / dev.sh.
# Usage: ./scripts/stop.sh [--dry-run]
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PID_FILE="${RH_PID_FILE:-/tmp/rh-trader-backend.pid}"
DRY=0
[ "${1:-}" = "--dry-run" ] && DRY=1

stop_pid() {
  local pid="$1"
  if [ -z "$pid" ]; then return 0; fi
  if ! kill -0 "$pid" 2>/dev/null; then return 0; fi
  if [ "$DRY" = 1 ]; then echo "dry-run: kill -TERM $pid"; return 0; fi
  kill -TERM "$pid" 2>/dev/null || true
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    kill -0 "$pid" 2>/dev/null || return 0
    sleep 0.2
  done
  kill -KILL "$pid" 2>/dev/null || true
}

if [ "$DRY" = 1 ]; then
  echo "dry-run: would stop pid-file $PID_FILE and leftover tsx src/index.ts / vite"
  echo "dry-run: curl health after stop should fail"
  exit 0
fi

if [ -f "$PID_FILE" ]; then
  stop_pid "$(cat "$PID_FILE" 2>/dev/null || true)"
  rm -f "$PID_FILE"
fi

# Leftovers from older launchers (pkill is a last resort; scoped to this repo's entry).
pkill -f "$ROOT/backend/src/index.ts" >/dev/null 2>&1 || true
pkill -f "tsx src/index.ts" >/dev/null 2>&1 || true
pkill -f "tsx watch src/index.ts" >/dev/null 2>&1 || true

echo "stop: backend listeners on :8011 should be gone"
echo "stop: check with ./scripts/health.sh (expect failure if nothing else is bound)"
