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

# POST with empty body, capture status + body. Args: name, path
post_json() {
  local name="$1"
  local path="$2"
  local body="${3:-}"
  print_header "$name"
  local out code
  if [ -n "$body" ]; then
    out=$(curl -fsS -X POST -H "Content-Type: application/json" -d "$body" "$API/$path" 2>&1)
  else
    out=$(curl -fsS -X POST "$API/$path" 2>&1)
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
#post_json "d-retryable-error"  "d-retryable-error"
post_json "e-sagas"            "e-sagas"

# ----- Hooks (f-i, l, o) -----
post_json "f-hooks (start)"    "f-hooks"
# f uses a random token printed only in workflow logs - cannot resume blindly.

post_json "g-custom-hooks (start)" "g-custom-hooks"
sleep 1
post_json "g-resume"               "g-resume"

post_json "h-hooks-multiple-events (start)" "h-hooks-multiple-events" || true
# h uses a random token; only verifying the start.

post_json "i-disposing-hooks-early (start)" "i-disposing-hooks-early" || true
# i uses token "channel:channel123" - we'd need a resume route to drive it.

post_json "l-manual-hook-disposal (start)" "l-manual-hook-disposal"
sleep 1
post_json "l-resume"                       "l-resume"

post_json "o-typed-hooks (start)" "o-typed-hooks" '{"documentId":"doc-test"}'
sleep 1
post_json "o-resume"              "o-resume" '{"documentId":"doc-test","requestId":"req-1","approved":true,"approvedBy":"alice","comment":"  ok  "}'

# ----- Webhooks (j, k, m, n) -----
post_json "j-webhooks (start)"               "j-webhooks"
post_json "k-webhooks-auto-response (start)" "k-webhooks-auto-response"
post_json "m-webhook-dynamic-response (start)" "m-webhook-dynamic-response"
post_json "n-webhook-multiple-requests (start)" "n-webhook-multiple-requests"
echo ""
echo "Note: j/k/m/n print their webhook URL to the dev server console."
echo "      To complete those workflows, POST a payload to the printed URL."

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
