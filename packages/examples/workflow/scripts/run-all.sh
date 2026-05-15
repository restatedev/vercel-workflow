#!/usr/bin/env bash
#
# Smoke-test every workflow example against a running dev server.
#
# Usage:
#   pnpm --filter @restatedev/workflow-example dev   # in another terminal
#   ./scripts/run-all.sh
#
# Optional env:
#   BASE   - base URL of the dev server (default: http://localhost:3000)

set -u

BASE="${BASE:-http://localhost:3000}"
API="$BASE/api"

PASSED=0
FAILED=0
FAILED_NAMES=()

print_header() {
  echo ""
  echo "=== $1 ==="
}

# Marks a step as passed/failed and prints output. Args: name, exit_code, output
record() {
  local name="$1"
  local code="$2"
  local out="$3"
  if [ "$code" -eq 0 ]; then
    PASSED=$((PASSED + 1))
    echo "  PASS"
    [ -n "$out" ] && echo "  $out"
  else
    FAILED=$((FAILED + 1))
    FAILED_NAMES+=("$name")
    echo "  FAIL (exit $code)"
    [ -n "$out" ] && echo "  $out"
  fi
}

# POST with optional body, capture status + body. Args: name, path, [body], [max_time_seconds]
# Default timeout is 30s; pass a shorter value for examples expected to hang
# (e.g. webhook examples using respondWith, which the Restate world doesn't
# implement yet — they'll be recorded as failures and we move on).
post_json() {
  local name="$1"
  local path="$2"
  local body="${3:-}"
  local max_time="${4:-30}"
  print_header "$name"
  local out code
  if [ -n "$body" ]; then
    out=$(curl -fsS --max-time "$max_time" -X POST -H "Content-Type: application/json" -d "$body" "$API/$path" 2>&1)
  else
    out=$(curl -fsS --max-time "$max_time" -X POST "$API/$path" 2>&1)
  fi
  code=$?
  record "$name" "$code" "$out"
}

# POST and stream the response body to stdout (with timeout). Args: name, path, [body]
post_stream() {
  local name="$1"
  local path="$2"
  local body="${3:-}"
  print_header "$name (streaming)"
  local out code
  if [ -n "$body" ]; then
    out=$(curl -fsS --max-time 30 -X POST -H "Content-Type: application/json" -d "$body" "$API/$path" 2>&1)
  else
    out=$(curl -fsS --max-time 30 -X POST "$API/$path" 2>&1)
  fi
  code=$?
  record "$name" "$code" "$out"
}

# ----- Plain workflows (a-e) -----
post_json "a-simple"           "a-simple"
post_json "b-sleep"            "b-sleep"
post_json "c-fatal-error"      "c-fatal-error"
post_json "d-retryable-error"  "d-retryable-error"
post_json "e-sagas"            "e-sagas"

# ----- Hooks & webhooks -----
# Every hook/webhook example is self-driving: the workflow registers a
# callback against /api/mock-callback, which POSTs back to the example's resume
# endpoint (or directly to the webhook URL). The route then awaits the
# workflow's return value and returns it, so each POST below waits for the
# full lifecycle and gets the workflow output in the response body.
post_json "f-hooks"                     "f-hooks"
post_json "g-custom-hooks"              "g-custom-hooks"
post_json "h-hooks-multiple-events"     "h-hooks-multiple-events"
post_json "i-disposing-hooks-early"     "i-disposing-hooks-early"
post_json "j-webhooks"                  "j-webhooks"
post_json "k-webhooks-auto-response"    "k-webhooks-auto-response"
post_json "l-manual-hook-disposal"      "l-manual-hook-disposal"
# m and n use respondWith — not yet implemented in this world. Give them a
# short timeout so they fail fast and don't block the rest of the suite.
post_json "m-webhook-dynamic-response"  "m-webhook-dynamic-response"  "" 5
post_json "n-webhook-multiple-requests" "n-webhook-multiple-requests" "" 5
post_json "o-typed-hooks"               "o-typed-hooks" '{"documentId":"doc-test"}'

# ----- Streaming (p-x) -----
#post_stream "p-streaming-basic"      "p-streaming-basic"
#
#print_header "q-streaming-resume (start + read)"
#RESP=$(curl -fsS -X POST "$API/q-streaming-resume" 2>&1)
#RC=$?
#if [ "$RC" -eq 0 ]; then
#  RUN_ID=$(echo "$RESP" | sed -n 's/.*"runId":"\([^"]*\)".*/\1/p')
#  if [ -n "$RUN_ID" ]; then
#    echo "  runId: $RUN_ID"
#    sleep 2
#    out=$(curl -fsS --max-time 10 "$API/q-streaming-resume/$RUN_ID?startIndex=-5" 2>&1)
#    record "q-streaming-resume" "$?" "$out"
#  else
#    record "q-streaming-resume" 1 "Could not parse runId from: $RESP"
#  fi
#else
#  record "q-streaming-resume" "$RC" "$RESP"
#fi
#
#print_header "r-streaming-input-arg"
#out=$(curl -fsS --max-time 30 -X POST -H "Content-Type: text/plain" --data-binary "hello stream world" "$API/r-streaming-input-arg" 2>&1)
#record "r-streaming-input-arg" "$?" "$out"
#
#post_stream "s-streaming-namespaced" "s-streaming-namespaced"
#post_stream "t-streaming-progress"   "t-streaming-progress" '{"items":["a","b"]}'
#post_json   "u-streaming-between-steps" "u-streaming-between-steps"
#post_json   "v-streaming-file-pipeline" "v-streaming-file-pipeline"
#post_json   "w-streaming-errors"        "w-streaming-errors"
#
#if [ -n "${ANTHROPIC_API_KEY:-}" ]; then
#  post_stream "x-streaming-ai" "x-streaming-ai" '{"message":"Hello"}'
#else
#  print_header "x-streaming-ai"
#  echo "  SKIP (set ANTHROPIC_API_KEY to run)"
#fi

# ----- Idempotency (y) -----
post_json "y-idempotency" "y-idempotency" '{"userId":"user_test","amount":2500}'

# ----- Summary -----
echo ""
echo "================================"
echo "Passed: $PASSED   Failed: $FAILED"
if [ "$FAILED" -gt 0 ]; then
  echo "Failed steps:"
  for n in "${FAILED_NAMES[@]}"; do
    echo "  - $n"
  done
  exit 1
fi
