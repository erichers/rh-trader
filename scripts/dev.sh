#!/usr/bin/env bash
# Dev mode: backend (tsx watch on :8011) + Vite dev server (:5173 with proxy).
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
pkill -f "tsx watch src/index.ts" >/dev/null 2>&1 || true
( cd "$ROOT/backend" && npm run dev ) &
( cd "$ROOT/frontend" && npm run dev ) &
echo "Backend :8011 · Frontend http://localhost:5173"
wait
