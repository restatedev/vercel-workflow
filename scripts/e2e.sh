#!/usr/bin/env bash
set -euo pipefail

# ---------------------------------------------------------------------------
# Run the vendored upstream e2e suite against the local examples app
# (packages/examples/workflow) and a local Restate server.
#
# This replaces the old scripts/e2e-upstream.sh — no upstream clone, no
# workbench patching, no symlink resolution. Everything needed lives in this
# repo.
#
# Usage:
#   ./scripts/e2e.sh                       # run full suite
#   TESTS_FILTER='hookWorkflow' ./scripts/e2e.sh   # narrow via vitest -t
#
# Environment variables:
#   RESTATE_MAX_ATTEMPTS - Restate retry policy max_attempts (default: 1)
# ---------------------------------------------------------------------------

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
EXAMPLE_APP="$REPO_ROOT/packages/examples/workflow"
WORKFLOW_LIB="$REPO_ROOT/packages/libs/workflow"

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[0;33m'; BLUE='\033[0;34m'; NC='\033[0m'
log()      { echo -e "${BLUE}==>${NC} $*"; }
log_ok()   { echo -e "${GREEN}==>${NC} $*"; }
log_warn() { echo -e "${YELLOW}==>${NC} $*"; }
log_err()  { echo -e "${RED}==>${NC} $*"; }

DOCKER_CONTAINER="restate-e2e"
DEV_PID=""

cleanup() {
  local exit_code=$?
  log "Cleaning up..."
  # Kill the dev server's whole process group — `pnpm dev` spawns `next dev`
  # as a child, and `kill $DEV_PID` only kills the parent.
  if [[ -n "$DEV_PID" ]]; then
    kill -- "-$DEV_PID" 2>/dev/null || kill "$DEV_PID" 2>/dev/null || true
  fi
  pkill -f "next dev" 2>/dev/null || true
  docker logs "$DOCKER_CONTAINER" > "$REPO_ROOT/docker-restate.log" 2>&1 || true
  docker rm -f "$DOCKER_CONTAINER" 2>/dev/null || true
  exit "$exit_code"
}
trap cleanup EXIT

# --- Build the workflow lib so the examples app picks up local changes ---
log "Building @restatedev/workflow..."
cd "$REPO_ROOT"
pnpm install --frozen-lockfile
pnpm build

# --- Start Restate via Docker ---
log "Starting Restate container..."
docker rm -f "$DOCKER_CONTAINER" 2>/dev/null || true

# MAX_ATTEMPTS=1 + kill = fail-fast: any non-terminal error kills the
# invocation immediately rather than burning minutes on retry storms while
# the test is just polling for status. Bump for tests that exercise retries.
docker run -d --name "$DOCKER_CONTAINER" \
  -p 8080:8080 -p 9070:9070 \
  -e RESTATE_DEFAULT_RETRY_POLICY__MAX_ATTEMPTS="${RESTATE_MAX_ATTEMPTS:-1}" \
  -e RESTATE_DEFAULT_RETRY_POLICY__ON_MAX_ATTEMPTS=kill \
  -e RESTATE_DEFAULT_RETRY_POLICY__INITIAL_INTERVAL=100ms \
  -e RESTATE_DEFAULT_RETRY_POLICY__MAX_INTERVAL=1s \
  docker.io/restatedev/restate:1.6.2

log "Waiting for Restate to be ready..."
for i in $(seq 1 30); do
  if curl -sf http://localhost:9070/health > /dev/null 2>&1; then
    log_ok "Restate is ready"; break
  fi
  if [[ "$i" -eq 30 ]]; then log_err "Restate failed to start"; exit 1; fi
  sleep 2
done

# --- Start the examples dev server ---
export WORKFLOW_TARGET_WORLD="@restatedev/workflow/world"
export RESTATE_INGRESS="http://localhost:8080"
export RESTATE_ADMIN_URL="http://localhost:9070"
export DEPLOYMENT_URL="http://localhost:3000"
export WORKFLOW_PUBLIC_MANIFEST=1
export NODE_OPTIONS="--enable-source-maps"

log "Starting examples dev server..."
cd "$EXAMPLE_APP"
pnpm dev > "$REPO_ROOT/server-restate.log" 2>&1 &
DEV_PID=$!
cd "$REPO_ROOT"

log "Waiting for dev server (pid $DEV_PID)..."
# The examples app has no `/` route — poll the manifest endpoint instead.
for i in $(seq 1 60); do
  if curl -sf http://localhost:3000/.well-known/workflow/v1/manifest.json > /dev/null 2>&1; then
    log_ok "Dev server is ready"; break
  fi
  if ! kill -0 "$DEV_PID" 2>/dev/null; then
    log_err "Dev server exited unexpectedly. Last logs:"
    tail -30 "$REPO_ROOT/server-restate.log"
    exit 1
  fi
  if [[ "$i" -eq 60 ]]; then
    log_err "Dev server failed to start. Last logs:"
    tail -30 "$REPO_ROOT/server-restate.log"
    exit 1
  fi
  sleep 2
done

# --- Register the deployment with Restate ---
if [[ "$(uname)" == "Darwin" ]]; then
  DOCKER_HOST_ADDR="host.docker.internal"
else
  DOCKER_HOST_ADDR="localhost"
fi

log "Warming up .restate-well-known route (Turbopack compiles on-demand)..."
curl -s "http://localhost:3000/.restate-well-known" -o /dev/null || true
sleep 5

log "Registering dev server with Restate..."
for attempt in $(seq 1 10); do
  HTTP_CODE=$(curl -s -o /tmp/restate-register.json -w "%{http_code}" \
    -X POST http://localhost:9070/deployments \
    -H 'content-type: application/json' \
    -d "{\"uri\": \"http://${DOCKER_HOST_ADDR}:3000/.restate-well-known\", \"use_http_11\": true}" 2>&1)
  BODY=$(cat /tmp/restate-register.json 2>/dev/null)
  if [[ "$HTTP_CODE" == "200" ]] || [[ "$HTTP_CODE" == "201" ]]; then
    log_ok "Registered with Restate (HTTP $HTTP_CODE)"; break
  fi
  log_warn "Registration attempt $attempt failed (HTTP $HTTP_CODE): $BODY"
  sleep 5
done

# --- Run vendored e2e tests ---
log "Running vendored e2e suite..."
cd "$WORKFLOW_LIB"
EXIT_CODE=0
if [[ -n "${TESTS_FILTER:-}" ]]; then
  log "Filtering tests: -t '${TESTS_FILTER}'"
  pnpm test:e2e -t "${TESTS_FILTER}" || EXIT_CODE=$?
else
  pnpm test:e2e || EXIT_CODE=$?
fi

if [[ "$EXIT_CODE" -eq 0 ]]; then
  log_ok "All e2e tests passed!"
else
  log_warn "Some e2e tests failed (exit code: $EXIT_CODE)"
  log "Server log: $REPO_ROOT/server-restate.log"
  log "Restate log: $REPO_ROOT/docker-restate.log"
fi

exit "$EXIT_CODE"
