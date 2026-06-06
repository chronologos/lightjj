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
#   - bombadil binary >= 0.4.0 on PATH (https://github.com/antithesishq/bombadil/releases)
#     v0.3.x cannot instrument <script type="module"> — blank page (fixed in #75).
#   - lightjj built at repo root (go build ./cmd/lightjj)
#   - pnpm install in this dir (for @antithesishq/bombadil types)

set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"

BV=$(bombadil --version 2>/dev/null | awk '{print $2}')
case "$BV" in
  0.[0-3].*|"") echo "bombadil >= 0.4.0 required (found '${BV:-none}'); see prereqs above" >&2; exit 1 ;;
esac

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

# Defensive: pre-warm the API before fuzzing. Polling `/` above only confirms
# the HTTP server has bound — it doesn't run the first (cold) `jj log`
# subprocess. bombadil's time-windowed liveness properties (e.g. appMounts'
# `eventually(...).within(5,"seconds")`) advance on a per-captured-state clock,
# so warming the cold path here keeps a slow first `jj log` (+ op-id seed) from
# eating into that budget on a contended runner. The API is tab-scoped — the
# `-R` repo mounts as tab "0", so /tab/0/api/log is the real log route
# (bare /api/log 404s; only /api/config + /api/state live at the root). Not
# load-bearing for the stub-binary bug this directory's history documents
# (missing `-tags embed` in e2e.yml) — just removes a cold-start flake class.
for _ in $(seq 50); do
  curl -sf "http://localhost:$PORT/tab/0/api/log" >/dev/null && break
  sleep 0.1
done

# --- bombadil ------------------------------------------------------------
rm -rf "$OUT"
HEADLESS_FLAG="--headless"
[ -n "${HEADED:-}" ] && HEADLESS_FLAG=""

# `chromiumoxide::handler WS Invalid message` warnings are benign — newer
# CDP events the bundled chromiumoxide doesn't recognize; actions still fire.
# Headless throughput is screenshot-capture-bound — observed ~3-5 actions in
# 60s on a loaded machine (worse under contention), so the time-windowed
# `eventually(...).within(N,"seconds")` properties effectively get 0-1
# actions per window. `--device-scale-factor 1` halves screenshot pixel
# area vs the default 2 (one fewer thing the capture has to chew on);
# HEADED=1 is ~60× faster but produces blank screenshots in the bundled
# Chromium (known — see e2e/bombadil notes). For real liveness coverage,
# either crank DURATION way up or wait for `bombadil test` to grow a
# step-count flag.
timeout "${DURATION}s" bombadil test \
  "http://localhost:$PORT" \
  "$HERE/spec.ts" \
  --output-path "$OUT" \
  --exit-on-violation \
  --device-scale-factor 1 \
  $HEADLESS_FLAG \
  ${BOMBADIL_FLAGS:-} \
  || true  # timeout exits 124; violations exit nonzero — both expected

# --- report --------------------------------------------------------------
if [ -f "$OUT/trace.jsonl" ]; then
  VIOLATED=$(jq -r 'select(.violations != []) | .violations[].name' "$OUT/trace.jsonl" 2>/dev/null | sort -u)
  ACTIONS=$(jq -r '.action // empty | keys[0]' "$OUT/trace.jsonl" 2>/dev/null | wc -l | tr -d ' ')
  if [ -n "$VIOLATED" ]; then
    echo
    echo "=== VIOLATIONS ==="
    echo "$VIOLATED"
    echo
    echo "full detail:"
    jq -c 'select(.violations != []) | .violations[]' "$OUT/trace.jsonl" | head -5
    exit 1
  fi
  echo "✓ no violations in ${DURATION}s (${ACTIONS} actions)"
else
  echo "no trace produced — bombadil may have failed to start" >&2
  exit 2
fi
