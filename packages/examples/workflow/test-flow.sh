#!/usr/bin/env bash
#
# Test the full Run lifecycle: start → status → cancel → restart → complete
#
# Prerequisites:
#   1. Restate running (docker-compose up -d runtime)
#   2. Example app running (pnpm examples:dev)
#   3. Endpoint registered with Restate
#
# Usage: ./test-flow.sh [app_url] [restate_ingress]

set -euo pipefail

APP=${1:-http://localhost:3000}
INGRESS=${2:-http://localhost:8080}

blue()  { printf "\033[1;34m%s\033[0m\n" "$*"; }
green() { printf "\033[1;32m%s\033[0m\n" "$*"; }
red()   { printf "\033[1;31m%s\033[0m\n" "$*"; }

# ---------- 1. Start a workflow ----------
blue "=== 1. Starting workflow ==="
START_RESPONSE=$(curl -s -X POST "$APP/api/signup" \
  -H 'Content-Type: application/json' \
  -d '{"email": "test@example.com"}')
echo "$START_RESPONSE"

RUN_ID=$(echo "$START_RESPONSE" | python3 -c "import sys,json; print(json.load(sys.stdin)['runId'])")
green "Run ID: $RUN_ID"

sleep 1

# ---------- 2. Check status (should be running) ----------
blue "=== 2. Checking status (expect: running) ==="
STATUS_RESPONSE=$(curl -s "$APP/api/signup/$RUN_ID")
echo "$STATUS_RESPONSE"

# ---------- 3. Cancel the workflow ----------
blue "=== 3. Cancelling workflow ==="
CANCEL_RESPONSE=$(curl -s -X DELETE "$APP/api/signup/$RUN_ID")
echo "$CANCEL_RESPONSE"

sleep 1

# ---------- 4. Verify cancelled status ----------
blue "=== 4. Checking status after cancel (expect: cancelled) ==="
STATUS_RESPONSE=$(curl -s "$APP/api/signup/$RUN_ID")
echo "$STATUS_RESPONSE"

# ---------- 5. Restart the workflow ----------
blue "=== 5. Restarting workflow ==="
RESTART_RESPONSE=$(curl -s -X POST "$APP/api/signup/$RUN_ID/restart")
echo "$RESTART_RESPONSE"

sleep 1

# ---------- 6. Check status again (should be running) ----------
blue "=== 6. Checking status after restart (expect: running) ==="
STATUS_RESPONSE=$(curl -s "$APP/api/signup/$RUN_ID")
echo "$STATUS_RESPONSE"

# ---------- 7. Cancel again to clean up ----------
blue "=== 7. Cleaning up — cancelling restarted workflow ==="
curl -s -X DELETE "$APP/api/signup/$RUN_ID"

sleep 1

# ---------- 8. Start a fresh run and let it complete ----------
blue "=== 8. Starting a fresh workflow to test completion ==="
START2=$(curl -s -X POST "$APP/api/signup" \
  -H 'Content-Type: application/json' \
  -d '{"email": "complete-test@example.com"}')
echo "$START2"

RUN_ID2=$(echo "$START2" | python3 -c "import sys,json; print(json.load(sys.stdin)['runId'])")
green "Run ID: $RUN_ID2"

sleep 2

blue "Status before hooks:"
curl -s "$APP/api/signup/$RUN_ID2"
echo

# The workflow has: sendWelcomeEmail step → fetch → 3x sleep → untyped hook → typed hook
# After the sleeps complete, we need to resume both hooks.
# The hook tokens are logged by the workflow — check the app logs for them.

echo
green "=== Done ==="
echo
blue "The fresh workflow ($RUN_ID2) is now waiting on hooks."
blue "Check the app logs for hook tokens, then resume them:"
echo
echo "  # Resume the untyped hook:"
echo "  curl -X POST $INGRESS/workflowHooks/<TOKEN>/resolve \\"
echo "    -H 'Content-Type: application/json' \\"
echo "    -d '{\"message\": \"hello\"}'"
echo
echo "  # Resume the approval hook:"
echo "  curl -X PUT $APP/api/approval \\"
echo "    -H 'Content-Type: application/json' \\"
echo "    -d '{\"token\": \"<TOKEN>\", \"approved\": true, \"comment\": \"lgtm\"}'"
echo
echo "  # Then check the result:"
echo "  curl $APP/api/signup/$RUN_ID2"