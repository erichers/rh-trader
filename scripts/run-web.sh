#!/usr/bin/env bash
# Optional MAMP path: build SPA, start the Node API on :8011, optionally bounce Apache.
# Prefer ./scripts/start.sh when you only need the API (Linux CI, no MAMP).
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DRY=0
[ "${1:-}" = "--dry-run" ] && DRY=1

echo "▸ run-web — paper desk (never switches to live Robinhood)"

if [ "$DRY" = 1 ]; then
  echo "dry-run: ./scripts/start.sh --build  (API :8011 + frontend/dist)"
  echo "dry-run: optional MAMP MySQL :8889 / Apache :8888 if those binaries exist"
  echo "dry-run: UI http://127.0.0.1:8011/  or  http://localhost:8888/rh.tradingbot/"
  exit 0
fi

"$ROOT/scripts/start.sh" --build

MYSQL="/Applications/MAMP/Library/bin/mysql"
HTTPD="/Applications/MAMP/Library/bin/httpd"
CONF="/Applications/MAMP/conf/apache/httpd.conf"

if [ -x "$MYSQL" ]; then
  echo "▸ MAMP MySQL (optional, :8889)…"
  "$MYSQL" -u root -proot -h 127.0.0.1 -P 8889 -e "CREATE DATABASE IF NOT EXISTS rh_tradingbot" >/dev/null 2>&1 \
    || echo "  (MySQL not reachable on :8889 — start MAMP, or point .env at another MySQL)"
else
  echo "▸ no MAMP mysql binary — using whatever DB_HOST/DB_PORT is in .env"
fi

if [ -x "$HTTPD" ]; then
  echo "▸ MAMP Apache (optional)…"
  if ! curl -s -o /dev/null http://localhost:8888/ 2>/dev/null; then
    "$HTTPD" -k start -f "$CONF" 2>/dev/null || echo "  (start MAMP from the MAMP app)"
  else
    "$HTTPD" -k restart -f "$CONF" 2>/dev/null || true
  fi
  CODE=$(curl -s -o /dev/null -w "%{http_code}" http://localhost:8888/rh.tradingbot/ 2>/dev/null || true)
  echo "▸ http://localhost:8888/rh.tradingbot/ -> ${CODE:-down}"
else
  echo "▸ no MAMP httpd — use http://127.0.0.1:8011/ (Fastify serves the SPA)"
fi
