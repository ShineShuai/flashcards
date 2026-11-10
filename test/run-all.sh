#!/usr/bin/env bash
# Runs every test that works offline, plus the jsdom tier when jsdom is installed.
#   npm install --no-save jsdom@31.0.0      # UI tier
#   npm install --no-save playwright@1.63.0 && npx playwright install chromium   # layout
set -euo pipefail
cd "$(dirname "$0")/.."

for tz in Europe/Berlin America/Los_Angeles Asia/Tokyo; do
  echo "== fsrs-golden (TZ=$tz)"
  TZ="$tz" node test/fsrs-golden.mjs
done
for t in spell code config highlight contrast; do
  echo "== $t"
  node "test/$t.mjs"
done

if node -e "require.resolve('jsdom')" 2>/dev/null; then
  for t in test/ui/*.test.mjs; do
    echo "== $t"
    node "$t"
  done
else
  echo "-- skipping test/ui (npm install --no-save jsdom@31.0.0)"
fi
if node -e "require.resolve('playwright')" 2>/dev/null; then
  echo "== layout"
  node test/layout.mjs
fi
