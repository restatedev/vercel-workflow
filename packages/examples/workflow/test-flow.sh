#!/usr/bin/env bash
#
# Test the full Run lifecycle: start → status → cancel → complete with hooks
#
# Prerequisites:
#   1. Restate running (docker-compose up -d runtime)
#   2. Example app running with:
#        WORKFLOW_TARGET_WORLD=@restatedev/workflow/world \
#        RESTATE_INGRESS=http://localhost:8080 \
#        RESTATE_ADMIN_URL=http://localhost:9070 \
#        pnpm examples:dev
#   3. Endpoint registered with Restate
#
# Usage: ./test-flow.sh [app_url] [restate_ingress]

set -euo pipefail

APP=${1:-http://localhost:3000}
INGRESS=${2:-http://localhost:8080}

blue()  { printf "\033[1;34m%s\033[0m\n" "$*"; }
green() { printf "\033[1;32m%s\033[0m\n" "$*"; }

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
curl -s "$APP/api/signup/$RUN_ID"
echo

# ---------- 3. Cancel the workflow ----------
blue "=== 3. Cancelling workflow ==="
curl -s -X DELETE "$APP/api/signup/$RUN_ID"
echo

sleep 1

# ---------- 4. Verify cancelled status ----------
blue "=== 4. Checking status after cancel ==="
curl -s "$APP/api/signup/$RUN_ID"
echo

# ---------- 5. Start a fresh run to test completion ----------
blue "=== 5. Starting a fresh workflow for completion test ==="
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

echo
green "=== Done ==="
echo
blue "The workflow ($RUN_ID2) is now running (steps + sleeps + hooks)."
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
