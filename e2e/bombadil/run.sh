#!/usr/bin/env bash
# Orchestrate: fixture repo → lightjj server → bombadil fuzz.
#
# Usage:
#   ./run.sh              # 60s headless run, exit on first violation
#   HEADED=1 ./run.sh     # visible browser (watch the chaos)
#   DURATION=300 ./run.sh # longer run
#
# Output lands in ./out/ — trace.jsonl has every state + any violations.
# Grep for trouble:
#   jq -r 'select(.violations != []) | .violations[]' out/trace.jsonl
#
# Prereqs:
#   - bombadil binary on PATH (https://github.com/antithesishq/bombadil/releases)
#   - lightjj built at repo root (go build ./cmd/lightjj)
#   - pnpm install in this dir (for @antithesishq/bombadil types)

set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"

FIXTURE="${FIXTURE:-/tmp/lightjj-bombadil-fixture}"
PORT="${PORT:-3456}"
DURATION="${DURATION:-60}"
OUT="$HERE/out"

# --- fixture -------------------------------------------------------------
"$HERE/fixture.sh" "$FIXTURE"

# --- server --------------------------------------------------------------
# --no-watch + --snapshot-interval 0: no background refresh/snapshots to
# race Bombadil's timing. HOME override: lightjj reads os.UserConfigDir()
# for tab persistence + annotations; without isolation the user's real
# open tabs leak into the fixture's tab list.
HOME="$FIXTURE/.home" "$ROOT/lightjj" \
  -R "$FIXTURE" \
  --addr "localhost:$PORT" \
  --no-browser \
  --no-watch \
  --snapshot-interval 0 &
SERVER_PID=$!
trap 'kill $SERVER_PID 2>/dev/null; wait $SERVER_PID 2>/dev/null' EXIT

# Wait for server up. lightjj has no /health, so poll the root.
for _ in $(seq 50); do
  curl -sf "http://localhost:$PORT/" >/dev/null && break
  sleep 0.1
done

# --- bombadil ------------------------------------------------------------
rm -rf "$OUT"
HEADLESS_FLAG="--headless"
[ -n "${HEADED:-}" ] && HEADLESS_FLAG=""

# KNOWN ISSUE (bombadil v0.3.2): the Svelte 5 / Vite bundle does not
# execute in Bombadil's managed Chromium — blank page, zero Click actions,
# extractors see empty DOM. Same server renders fine in real Chrome.
# Suspect: JS instrumentation proxy vs the `crossorigin` attr on Vite's
# <script type="module">, or an outdated bundled Chromium. Tried
# `--instrument-javascript ""` — no effect.
#
# Workaround: use test-external against a Chrome launched with
#   /Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome \
#     --remote-debugging-port=9222 --user-data-dir=/tmp/chrome-bombadil
# then swap `bombadil test` → `bombadil test-external --remote-debugger
# http://localhost:9222 --create-target` below. Left as the managed-mode
# path for now since test-external adds a manual-Chrome-launch step.
timeout "${DURATION}s" bombadil test \
  "http://localhost:$PORT" \
  "$HERE/spec.ts" \
  --output-path "$OUT" \
  --exit-on-violation \
  $HEADLESS_FLAG \
  || true  # timeout exits 124; violations exit nonzero — both expected

# --- report --------------------------------------------------------------
if [ -f "$OUT/trace.jsonl" ]; then
  VIOLATED=$(jq -r 'select(.violations != []) | .violations[].name' "$OUT/trace.jsonl" 2>/dev/null | sort -u)
  if [ -n "$VIOLATED" ]; then
    echo
    echo "=== VIOLATIONS ==="
    echo "$VIOLATED"
    echo
    echo "full detail:"
    jq -c 'select(.violations != []) | .violations[]' "$OUT/trace.jsonl" | head -5
    exit 1
  fi
  echo "✓ no violations in ${DURATION}s"
else
  echo "no trace produced — bombadil may have failed to start" >&2
  exit 2
fi
