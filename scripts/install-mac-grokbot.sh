#!/usr/bin/env bash
# Put this paper-desk checkout at /Users/eric/Sites/grokbot/rh-trader and wire MAMP.
# Moves /Users/eric/Sites/rh.tradingbot here if that is where the old desk lived.
# Never prints .env secrets. Never switches TRADING_ENV to live.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
GROKBOT_ROOT="${RH_GROKBOT_ROOT:-/Users/eric/Sites/grokbot}"
TARGET="${GROKBOT_ROOT}/rh-trader"
LEGACY="/Users/eric/Sites/rh.tradingbot"
CONF="/Applications/MAMP/conf/apache/httpd.conf"
DRY=0
[ "${1:-}" = "--dry-run" ] && DRY=1

echo "▸ Mac desk install"
echo "▸ grokbot root  $GROKBOT_ROOT"
echo "▸ this branch   $TARGET"
echo "▸ MAMP URL      http://localhost:8888/grokbot/rh-trader/"

if [ "$DRY" = 1 ]; then
  echo "dry-run: mkdir -p $GROKBOT_ROOT"
  echo "dry-run: move $LEGACY → $TARGET if the legacy desk exists and target does not"
  echo "dry-run: rsync this checkout onto $TARGET (keep .env and oauth tokens)"
  echo "dry-run: BASE_PATH=/grokbot/rh-trader in .env"
  echo "dry-run: rewrite MAMP $CONF managed block from deploy/apache-grokbot-rh-trader.conf"
  echo "HOME=$TARGET"
  exit 0
fi

if [ "$(uname -s)" != "Darwin" ]; then
  echo "install-mac-grokbot: this organizes Eric's Mac (iEUGENE). On this host run ./scripts/start.sh instead."
  echo "HOME=$ROOT"
  exit 0
fi

mkdir -p "$GROKBOT_ROOT"

if [ -e "$LEGACY" ] && [ ! -e "$TARGET" ]; then
  echo "▸ moving $LEGACY → $TARGET"
  mv "$LEGACY" "$TARGET"
fi

sync_onto_target() {
  mkdir -p "$TARGET"
  rsync -a --delete \
    --exclude node_modules \
    --exclude frontend/dist \
    --exclude .env \
    --exclude backend/data/oauth-tokens.json \
    --exclude backend/data/*.json \
    "$ROOT/" "$TARGET/"
}

if [ "$(cd "$ROOT" && pwd)" != "$(mkdir -p "$TARGET" && cd "$TARGET" && pwd)" ]; then
  echo "▸ overlaying this branch onto $TARGET (keeping local .env)"
  if [ -f "$ROOT/.env" ] && [ ! -f "$TARGET/.env" ]; then
    cp "$ROOT/.env" "$TARGET/.env"
  fi
  sync_onto_target
fi

set_base_path() {
  local envf="$1"
  [ -f "$envf" ] || return 0
  if grep -q '^BASE_PATH=' "$envf"; then
    sed -i.bak 's|^BASE_PATH=.*|BASE_PATH=/grokbot/rh-trader|' "$envf"
    rm -f "${envf}.bak"
  else
    printf '\nBASE_PATH=/grokbot/rh-trader\n' >> "$envf"
  fi
}
set_base_path "$TARGET/.env"
set_base_path "$TARGET/.env.example"

SNIPPET="$TARGET/deploy/apache-grokbot-rh-trader.conf"
if [ -f "$CONF" ] && [ -f "$SNIPPET" ]; then
  echo "▸ writing MAMP Apache managed block"
  python3 - "$CONF" "$SNIPPET" <<'PY'
import pathlib, re, sys
conf, snippet = pathlib.Path(sys.argv[1]), pathlib.Path(sys.argv[2])
text = conf.read_text()
block = snippet.read_text()
# Keep only the grokbot managed block from the snippet (between markers).
m = re.search(r"# === rh-trader grokbot — BEGIN \(managed\) ===.*?# === rh-trader grokbot — END \(managed\) ===\n?", block, re.S)
if not m:
    raise SystemExit("snippet missing managed markers")
body = m.group(0)
text = re.sub(r"\n?# === rh\.tradingbot — BEGIN \(managed\) ===.*?# === rh\.tradingbot — END \(managed\) ===\n?", "\n", text, flags=re.S)
if "# === rh-trader grokbot — BEGIN (managed) ===" in text:
    text = re.sub(r"# === rh-trader grokbot — BEGIN \(managed\) ===.*?# === rh-trader grokbot — END \(managed\) ===\n?", body, text, flags=re.S)
else:
    if not text.endswith("\n"):
        text += "\n"
    text += "\n" + body + "\n"
conf.write_text(text)
PY
else
  echo "▸ no MAMP httpd.conf at $CONF — skip Apache (Fastify on :8011 still works)"
fi

echo "HOME=$TARGET"
echo "install: desk is at $TARGET"
echo "install: open http://localhost:8888/grokbot/rh-trader/ after ./scripts/desk-up.sh"
