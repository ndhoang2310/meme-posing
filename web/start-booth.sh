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

# Rebuild when dist is missing or any source is newer than the last build,
# so code/config changes always take effect on next launch.
if [ ! -d dist ] || [ -n "$(find src public index.html vite.config.ts tsconfig.json package.json -newer dist -print -quit 2>/dev/null)" ]; then
  echo "[booth] building..."
  npm run build
fi

echo "[booth] open with:  google-chrome --kiosk http://localhost:${PORT} --use-fake-ui-for-media-stream"
PORT="${PORT}" node serve-booth.mjs
