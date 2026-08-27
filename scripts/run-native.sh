#!/usr/bin/env bash
# Native macOS app launcher. Ensures MySQL + the Node backend are running, then
# opens the Tauri window (which loads http://127.0.0.1:8011/).
#   ./scripts/run-native.sh         → dev window (cargo tauri dev)
#   ./scripts/run-native.sh build   → produce a .app/.dmg bundle
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
MYSQL="/Applications/MAMP/Library/bin/mysql80/bin/mysql"

echo "▸ MAMP MySQL…"
"$MYSQL" -u root -proot -h 127.0.0.1 -P 8889 -e "CREATE DATABASE IF NOT EXISTS rh_tradingbot" >/dev/null 2>&1 \
  || echo "  (start MAMP)"
"$MYSQL" -u root -proot -h 127.0.0.1 -P 8889 < "$ROOT/db/schema.sql" >/dev/null 2>&1 || true

echo "▸ Building SPA…"; ( cd "$ROOT/frontend" && npm run build ) || exit 1

echo "▸ Node backend on :8011…"
pkill -f "tsx src/index.ts" >/dev/null 2>&1; sleep 1
( cd "$ROOT/backend" && nohup npm start >/tmp/rhbot.log 2>&1 & )
sleep 4

cd "$ROOT/app-native/src-tauri"
if [ "${1:-}" = "build" ]; then
  echo "▸ Building native bundle (cargo tauri build)…"
  cargo tauri build --bundles app dmg
else
  echo "▸ Launching native dev window…"
  cargo tauri dev
fi
