#!/bin/sh
# Booth launcher: build (if needed) + serve the static game on localhost.
# Run from the repo folder on the booth machine:  sh web/start-booth.sh
set -eu
cd "$(dirname "$0")"

PORT="${PORT:-8080}"

if [ ! -d node_modules ]; then
  echo "[booth] installing dependencies (needs internet once)..."
  npm install --no-audit --no-fund
fi

if [ ! -d dist ]; then
  echo "[booth] building..."
  npm run build
fi

echo "[booth] serving at http://localhost:${PORT}  (Ctrl+C to stop)"
echo "[booth] open with:  google-chrome --kiosk http://localhost:${PORT} --use-fake-ui-for-media-stream"
npx --yes serve dist -l "${PORT}"
