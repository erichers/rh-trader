#!/usr/bin/env bash
# Canonical WEB launcher — serves rh.tradingbot at http://localhost:8888/rh.tradingbot/
# via MAMP Apache, backed by MAMP MySQL. Builds the SPA, (re)starts the Node backend
# on :8011, ensures Apache is up.
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
MYSQL="/Applications/MAMP/Library/bin/mysql"
HTTPD="/Applications/MAMP/Library/bin/httpd"
CONF="/Applications/MAMP/conf/apache/httpd.conf"

echo "▸ MAMP MySQL…"
"$MYSQL" -u root -proot -h 127.0.0.1 -P 8889 -e "CREATE DATABASE IF NOT EXISTS rh_tradingbot" >/dev/null 2>&1 \
  || echo "  (MySQL not reachable on :8889 — start MAMP)"
"$MYSQL" -u root -proot -h 127.0.0.1 -P 8889 < "$ROOT/db/schema.sql" >/dev/null 2>&1 || true

echo "▸ Building SPA → frontend/dist…"
( cd "$ROOT/frontend" && npm run build ) || { echo "build failed"; exit 1; }

echo "▸ Node backend on :8011…"
pkill -f "tsx src/index.ts" >/dev/null 2>&1; sleep 1
( cd "$ROOT/backend" && nohup npm start >/tmp/rhbot.log 2>&1 & )
sleep 4

echo "▸ MAMP Apache…"
if ! curl -s -o /dev/null http://localhost:8888/ 2>/dev/null; then
  "$HTTPD" -k start -f "$CONF" 2>/dev/null || echo "  (start MAMP from the MAMP app)"
else
  "$HTTPD" -k restart -f "$CONF" 2>/dev/null || true
fi
sleep 2

CODE=$(curl -s -o /dev/null -w "%{http_code}" http://localhost:8888/rh.tradingbot/ 2>/dev/null)
echo "▸ http://localhost:8888/rh.tradingbot/ -> $CODE"
[ "$CODE" = "200" ] && open "http://localhost:8888/rh.tradingbot/" || echo "  (not 200 — check /tmp/rhbot.log and that MAMP Apache is running)"
