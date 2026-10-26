#!/usr/bin/env bash
# One load run: k6 REST players + realtime street players + a /metrics
# sampler, all on the same staircase (1/3, 2/3, all of PEAK), then the top
# queries from pg_stat_statements. See docs/LOAD-TEST.md.
#
#   API=http://localhost:4010 WS=ws://localhost:2567 PEAK=300 \
#   PG_URL=postgres://ctlife:ctlife@localhost:5436/ctlife_load \
#   OUT=./load-results tools/load/run.sh
#
# PG_URL is optional; without it the pg_stat_statements steps are skipped.
# Never point PG_URL at production: the run resets pg_stat_statements.
set -euo pipefail

API=${API:-http://localhost:4010}
WS=${WS:-ws://localhost:2567}
PEAK=${PEAK:-300}
HOLD_S=${HOLD_S:-180}
HOT=${HOT:-0.6}
THINK=${THINK:-1}
OUT=${OUT:-./load-results}
PG_URL=${PG_URL:-}
HERE=$(cd "$(dirname "$0")" && pwd)
ROOT=$(cd "$HERE/../.." && pwd)
mkdir -p "$OUT"
METRICS_URLS="$API/metrics,${WS/ws:/http:}/metrics"
METRICS_URLS=${METRICS_URLS/wss:/https:}
TOTAL_S=$((3 * (60 + HOLD_S) + 30))

command -v k6 >/dev/null || { echo "k6 is not installed (https://grafana.com/docs/k6/latest/set-up/install-k6/)"; exit 1; }

if [ -n "$PG_URL" ]; then
  psql "$PG_URL" -qc "CREATE EXTENSION IF NOT EXISTS pg_stat_statements; SELECT pg_stat_statements_reset();" >/dev/null
fi

cd "$ROOT"
pnpm exec tsx tools/load/sample-metrics.ts --urls "$METRICS_URLS" --every 5 --duration "$TOTAL_S" \
  --out "$OUT/metrics.json" >"$OUT/metrics.log" 2>&1 &
SAMPLER=$!
pnpm exec tsx tools/load/street-players.ts --api "$API" --ws "$WS" --players "$PEAK" --steps 3 \
  --ramp 60 --hold "$HOLD_S" --hot "$HOT" --out "$OUT/street.json" >"$OUT/street.log" 2>&1 &
STREET=$!
k6 run -q -e API="$API" -e PEAK="$PEAK" -e STEP_HOLD="${HOLD_S}s" -e THINK="$THINK" \
  -e OUT="$OUT/rest.json" tools/load/k6/rest-players.js | tee "$OUT/rest.txt" || true
wait "$STREET" || true
wait "$SAMPLER" || true

if [ -n "$PG_URL" ]; then
  psql "$PG_URL" -P pager=off -f "$HERE/pg-top.sql" >"$OUT/pg-top.txt"
fi
echo "results in $OUT"
