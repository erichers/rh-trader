#!/usr/bin/env bash
# One command for the Mac desk: sit under /Users/eric/Sites/grokbot, start paper API,
# optional MAMP, arm backtest winners, open the browser.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DRY=0
ALREADY=0
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY=1 ;;
    --already-home) ALREADY=1 ;;
    *) echo "unknown arg: $arg" >&2; exit 2 ;;
  esac
done

echo "▸ desk-up — paper desk under grokbot (never live Robinhood)"

if [ "$DRY" = 1 ]; then
  echo "dry-run: ./scripts/install-mac-grokbot.sh"
  echo "dry-run: ./scripts/start.sh --build"
  echo "dry-run: optional MAMP Apache :8888 + MySQL :8889"
  echo "dry-run: ./scripts/paper-trade.sh"
  echo "dry-run: open http://localhost:8888/grokbot/grokbot-rh-trader/  (fallback http://127.0.0.1:8011/)"
  "$ROOT/scripts/install-mac-grokbot.sh" --dry-run
  "$ROOT/scripts/start.sh" --dry-run
  "$ROOT/scripts/paper-trade.sh" --dry-run
  exit 0
fi

if [ "$ALREADY" != 1 ]; then
  OUT="$("$ROOT/scripts/install-mac-grokbot.sh")"
  echo "$OUT"
  HOME_LINE="$(printf '%s\n' "$OUT" | awk -F= '/^HOME=/{print $2; exit}')"
  if [ -n "$HOME_LINE" ] && [ -x "$HOME_LINE/scripts/desk-up.sh" ] \
     && [ "$(cd "$ROOT" && pwd)" != "$(cd "$HOME_LINE" && pwd)" ]; then
    exec "$HOME_LINE/scripts/desk-up.sh" --already-home
  fi
fi

"$ROOT/scripts/start.sh" --build

MYSQL="/Applications/MAMP/Library/bin/mysql"
HTTPD="/Applications/MAMP/Library/bin/httpd"
CONF="/Applications/MAMP/conf/apache/httpd.conf"
MAMP_URL="http://localhost:8888/grokbot/grokbot-rh-trader/"
API_URL="http://127.0.0.1:8011/"

if [ -x "$MYSQL" ]; then
  echo "▸ MAMP MySQL :8889…"
  "$MYSQL" -u root -proot -h 127.0.0.1 -P 8889 -e "CREATE DATABASE IF NOT EXISTS rh_tradingbot" >/dev/null 2>&1 \
    || echo "  (MySQL not on :8889 — start MAMP, or point .env at another MySQL)"
fi

if [ -x "$HTTPD" ]; then
  echo "▸ MAMP Apache…"
  if ! curl -s -o /dev/null http://localhost:8888/ 2>/dev/null; then
    "$HTTPD" -k start -f "$CONF" 2>/dev/null || echo "  (start MAMP from the MAMP app)"
  else
    "$HTTPD" -k restart -f "$CONF" 2>/dev/null || true
  fi
fi

"$ROOT/scripts/paper-trade.sh" || echo "▸ paper-trade skipped (API/db/backtests). Desk is still up."

open_browser() {
  local url="$1"
  if command -v open >/dev/null 2>&1; then
    open "$url"
  elif command -v xdg-open >/dev/null 2>&1; then
    xdg-open "$url" >/dev/null 2>&1 || true
  fi
}

CODE="$(curl -s -o /dev/null -w '%{http_code}' "$MAMP_URL" 2>/dev/null || true)"
if [ "$CODE" = "200" ]; then
  echo "▸ opening $MAMP_URL"
  open_browser "$MAMP_URL"
else
  echo "▸ MAMP $MAMP_URL -> ${CODE:-down}; opening $API_URL"
  open_browser "$API_URL"
fi

echo "desk-up: API  $API_URL"
echo "desk-up: MAMP $MAMP_URL"
echo "desk-up: stop ./scripts/stop.sh"
