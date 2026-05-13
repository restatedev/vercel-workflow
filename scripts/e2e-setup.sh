#!/usr/bin/env bash
set -euo pipefail

# ---------------------------------------------------------------------------
# Set up the upstream e2e environment for INTERACTIVE use.
#
# This is the same as scripts/e2e-upstream.sh up to (but not including) the
# vitest run. After everything is running, the script stays in the foreground
# and prints commands you can copy-paste into another terminal to:
#   - run a single upstream test by name
#   - trigger a workflow directly via curl
#   - inspect run state through Restate
#
# Press Ctrl-C to tear everything down.
#
# Usage:
#   ./scripts/e2e-setup.sh             # restate (default)
#   ./scripts/e2e-setup.sh restate
#
# Environment variables:
#   UPSTREAM_REF       - git ref to clone (default: main)
#   WORKDIR            - upstream checkout location (default: .upstream)
#   CLEAN              - "1" to force re-clone
#   RESTATE_MAX_ATTEMPTS - Restate retry policy max_attempts (default: 1)
#   SKIP_BUILD         - "1" to skip rebuild (assumes tarball already exists)
# ---------------------------------------------------------------------------

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WORLD="${1:-restate}"
UPSTREAM_REF="${UPSTREAM_REF:-main}"
WORKDIR="${WORKDIR:-$REPO_ROOT/.upstream}"
APP_NAME="nextjs-turbopack"

if [[ "$WORLD" != "restate" ]]; then
  echo "This setup script only supports 'restate'. Got: $WORLD"
  exit 1
fi

# --- Colors ---
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m'

log()      { echo -e "${BLUE}==>${NC} $*"; }
log_ok()   { echo -e "${GREEN}==>${NC} $*"; }
log_warn() { echo -e "${YELLOW}==>${NC} $*"; }
log_err()  { echo -e "${RED}==>${NC} $*"; }
log_hint() { echo -e "${CYAN}    $*${NC}"; }

DOCKER_CONTAINER="restate-e2e"
DEV_PID=""

cleanup() {
  log "Cleaning up..."
  [[ -n "$DEV_PID" ]] && kill "$DEV_PID" 2>/dev/null || true
  docker logs "$DOCKER_CONTAINER" > "$WORKDIR/docker-${WORLD}.log" 2>&1 || true
  docker rm -f "$DOCKER_CONTAINER" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

# ----------------------------------------------------------------------------
# 1. Build local package
# ----------------------------------------------------------------------------
TARBALL_PATH=""
if [[ "${SKIP_BUILD:-}" != "1" ]]; then
  log "Building @restatedev/workflow..."
  cd "$REPO_ROOT"
  pnpm install --frozen-lockfile
  pnpm build

  log "Packing tarball..."
  cd packages/libs/workflow
  TARBALL=$(pnpm pack 2>&1 | tail -1)
  TARBALL_PATH="$(pwd)/$TARBALL"
  log_ok "Tarball: $TARBALL_PATH"
  cd "$REPO_ROOT"
else
  TARBALL_PATH="$REPO_ROOT/packages/libs/workflow/restatedev-workflow-0.0.0.tgz"
  if [[ ! -f "$TARBALL_PATH" ]]; then
    log_err "SKIP_BUILD=1 but tarball not found at $TARBALL_PATH"
    exit 1
  fi
  log_ok "Reusing tarball: $TARBALL_PATH"
fi

# ----------------------------------------------------------------------------
# 2. Clone / reuse upstream
# ----------------------------------------------------------------------------
if [[ "${CLEAN:-}" == "1" ]] || [[ ! -d "$WORKDIR" ]]; then
  log "Cloning upstream vercel/workflow @ $UPSTREAM_REF..."
  rm -rf "$WORKDIR"
  git clone --depth 1 --branch "$UPSTREAM_REF" https://github.com/vercel/workflow.git "$WORKDIR"
else
  log "Using existing upstream at $WORKDIR (set CLEAN=1 to force re-clone)"
fi

cd "$WORKDIR"

# ----------------------------------------------------------------------------
# 3. Install upstream deps
# ----------------------------------------------------------------------------
log "Installing upstream dependencies..."
UPSTREAM_PNPM_VERSION=$(node -e "const pm = require('./package.json').packageManager || ''; console.log(pm.split('@')[1] || '10.14.0')")
log "Upstream pnpm version: $UPSTREAM_PNPM_VERSION"
npm i -g "pnpm@${UPSTREAM_PNPM_VERSION}" 2>/dev/null || true
pnpm install --frozen-lockfile

log "Building upstream packages..."
pnpm turbo run build --filter='!./workbench/*'

# ----------------------------------------------------------------------------
# 4. Install our tarball into the workbench app
# ----------------------------------------------------------------------------
log "Installing $WORLD world into workbench..."
cd "workbench/$APP_NAME"
pnpm add "$TARBALL_PATH"
cd "$WORKDIR"

# ----------------------------------------------------------------------------
# 5. Patch the workbench
# ----------------------------------------------------------------------------
log "Patching workbench for Restate..."
node "$REPO_ROOT/scripts/patch-upstream-workbench.cjs" "workbench/$APP_NAME"
rm -rf "workbench/$APP_NAME/.next"

# ----------------------------------------------------------------------------
# 6. Resolve symlinks
# ----------------------------------------------------------------------------
log "Resolving symlinks..."
if [[ -f scripts/resolve-symlinks.sh ]]; then
  CI=true bash scripts/resolve-symlinks.sh "workbench/$APP_NAME"
else
  log_warn "No resolve-symlinks.sh found in upstream — skipping"
fi

# ----------------------------------------------------------------------------
# 7. Start Restate Docker container
# ----------------------------------------------------------------------------
log "Starting Restate Docker container..."
docker rm -f "$DOCKER_CONTAINER" 2>/dev/null || true

DOCKER_ENV="-e RESTATE_DEFAULT_RETRY_POLICY__MAX_ATTEMPTS=${RESTATE_MAX_ATTEMPTS:-1} -e RESTATE_DEFAULT_RETRY_POLICY__ON_MAX_ATTEMPTS=kill -e RESTATE_DEFAULT_RETRY_POLICY__INITIAL_INTERVAL=100ms -e RESTATE_DEFAULT_RETRY_POLICY__MAX_INTERVAL=1s"

# shellcheck disable=SC2086
docker run -d --name "$DOCKER_CONTAINER" \
  -p 8080:8080 -p 9070:9070 \
  $DOCKER_ENV \
  docker.io/restatedev/restate:1.6.2

log "Waiting for Restate to be ready..."
for i in $(seq 1 30); do
  if curl -sf http://localhost:9070/health > /dev/null 2>&1; then
    log_ok "Restate is ready"
    break
  fi
  if [[ "$i" -eq 30 ]]; then
    log_err "Restate failed to start"
    exit 1
  fi
  sleep 2
done

# ----------------------------------------------------------------------------
# 8. Set environment variables
# ----------------------------------------------------------------------------
export WORKFLOW_PUBLIC_MANIFEST=1
export DEPLOYMENT_URL="http://localhost:3000"
export WORKFLOW_SERVICE_URL="http://localhost:3000"
export NODE_OPTIONS="--enable-source-maps"
export APP_NAME="$APP_NAME"
export WORKFLOW_TARGET_WORLD="@restatedev/workflow/world"
export RESTATE_INGRESS="http://localhost:8080"

# ----------------------------------------------------------------------------
# 9. Start Next.js dev server
# ----------------------------------------------------------------------------
log "Starting dev server..."
cd "workbench/$APP_NAME"
pnpm dev > "$WORKDIR/server-${WORLD}.log" 2>&1 &
DEV_PID=$!
cd "$WORKDIR"

log "Waiting for dev server (pid $DEV_PID)..."
for i in $(seq 1 60); do
  if curl -sf http://localhost:3000 > /dev/null 2>&1; then
    log_ok "Dev server is ready"
    break
  fi
  if ! kill -0 "$DEV_PID" 2>/dev/null; then
    log_err "Dev server exited unexpectedly. Last logs:"
    tail -30 "$WORKDIR/server-${WORLD}.log"
    exit 1
  fi
  if [[ "$i" -eq 60 ]]; then
    log_err "Dev server failed to start. Last logs:"
    tail -30 "$WORKDIR/server-${WORLD}.log"
    exit 1
  fi
  sleep 2
done

# ----------------------------------------------------------------------------
# 10. Register with Restate
# ----------------------------------------------------------------------------
if [[ "$(uname)" == "Darwin" ]]; then
  DOCKER_HOST_ADDR="host.docker.internal"
else
  DOCKER_HOST_ADDR="localhost"
fi

log "Waiting for deferred builder to generate flow route..."
for i in $(seq 1 60); do
  if head -1 "workbench/$APP_NAME/app/.well-known/workflow/v1/flow/route.js" 2>/dev/null | grep -qv "STUB"; then
    log_ok "Flow route generated"
    break
  fi
  if [[ "$i" -eq 60 ]]; then
    log_err "Flow route still a stub after 120s"
  fi
  sleep 2
done

log "Warming up .restate-well-known route..."
curl -s "http://localhost:3000/.restate-well-known" -o /dev/null || true
sleep 5

log "Registering dev server with Restate..."
for attempt in $(seq 1 10); do
  HTTP_CODE=$(curl -s -o /tmp/restate-register.json -w "%{http_code}" -X POST http://localhost:9070/deployments \
    -H 'content-type: application/json' \
    -d "{\"uri\": \"http://${DOCKER_HOST_ADDR}:3000/.restate-well-known\", \"use_http_11\": true}" 2>&1)
  BODY=$(cat /tmp/restate-register.json 2>/dev/null)
  if [[ "$HTTP_CODE" == "200" ]] || [[ "$HTTP_CODE" == "201" ]]; then
    log_ok "Registered with Restate (HTTP $HTTP_CODE)"
    break
  fi
  log_warn "Registration attempt $attempt failed (HTTP $HTTP_CODE): $BODY"
  sleep 5
done

# ----------------------------------------------------------------------------
# Warm up our virtual-object routes so the first test doesn't pay Turbopack's
# on-demand compilation cost (which can manifest as a 404 from the Restate
# ingress: "service 'workflowRun' not found").
# ----------------------------------------------------------------------------
log "Warming up virtual-object routes..."
curl -s -X POST http://localhost:8080/workflowRun/warmup/get -o /dev/null || true
curl -s -X POST http://localhost:8080/workflowSleep/warmup/getPending -o /dev/null || true
curl -s -X POST http://localhost:8080/workflowHooks/warmup/get -o /dev/null || true
curl -s -X POST http://localhost:8080/workflowStream/warmup/getInfo -o /dev/null || true
curl -s -X POST http://localhost:8080/workflowRunStreams/warmup/list -o /dev/null || true
log_ok "Virtual-object routes warmed"

# ----------------------------------------------------------------------------
# Print interactive instructions
# ----------------------------------------------------------------------------
echo ""
echo "================================================================"
echo -e "${GREEN}  Setup complete — environment is live${NC}"
echo "================================================================"
echo ""
echo "  Restate ingress:    http://localhost:8080"
echo "  Restate admin:      http://localhost:9070"
echo "  Next.js dev server: http://localhost:3000"
echo ""
echo "  Logs:"
echo "    Next.js:  $WORKDIR/server-${WORLD}.log"
echo "    Restate:  docker logs -f $DOCKER_CONTAINER"
echo ""
echo "================================================================"
echo -e "${CYAN}  Run a single upstream e2e test${NC}"
echo "================================================================"
echo ""
echo "  In a NEW terminal, from this dir:"
echo ""
echo -e "    cd $WORKDIR"
echo -e "    export APP_NAME=nextjs-turbopack"
echo -e "    export DEPLOYMENT_URL=http://localhost:3000"
echo -e "    export RESTATE_INGRESS=http://localhost:8080"
echo -e "    export WORKFLOW_TARGET_WORLD=@restatedev/workflow/world"
echo -e "    export WORKFLOW_PUBLIC_MANIFEST=1"
echo -e "    export WORKFLOW_SERVICE_URL=http://localhost:3000"
echo ""
echo -e "    ${GREEN}# Run one test by name${NC}"
echo -e "    pnpm vitest run packages/core/e2e/e2e.test.ts -t 'addTenWorkflow'"
echo ""
echo -e "    ${GREEN}# Run several tests by regex${NC}"
echo -e "    pnpm vitest run packages/core/e2e/e2e.test.ts -t 'hookWorkflow|addTenWorkflow'"
echo ""
echo -e "    ${GREEN}# List tests without running${NC}"
echo -e "    pnpm vitest list packages/core/e2e/e2e.test.ts"
echo ""
echo "================================================================"
echo -e "${CYAN}  Or trigger a workflow directly${NC}"
echo "================================================================"
echo ""
echo "  Each workflow service is registered as a Restate handler. Look at"
echo "  http://localhost:9070/services to see them."
echo ""
echo "  Example — invoke addTenWorkflow with arg [123]:"
echo ""
echo -e "    ${GREEN}curl http://localhost:8080/addTenWorkflow/run \\\\${NC}"
echo -e "    ${GREEN}  -H 'content-type: application/json' \\\\${NC}"
echo -e "    ${GREEN}  -d '{\"serviceName\":\"addTenWorkflow\",\"payload\":\"[123]\",\"runId\":\"my-test-1\",\"workflowName\":\"workflow//./workflows/99_e2e//addTenWorkflow\"}'${NC}"
echo ""
echo "  (Note: this invokes the workflow service directly. Normally start()"
echo "  goes through the workflowRun virtual object first to create state.)"
echo ""
echo "================================================================"
echo -e "${CYAN}  Inspect runs${NC}"
echo "================================================================"
echo ""
echo -e "    ${GREEN}# State of a workflow run by id${NC}"
echo -e "    curl http://localhost:8080/workflowRun/<run-id>/get"
echo ""
echo -e "    ${GREEN}# All registered services${NC}"
echo -e "    curl http://localhost:9070/services"
echo ""
echo -e "    ${GREEN}# Recent invocations${NC}"
echo -e "    curl 'http://localhost:9070/query/invocations?limit=20'"
echo ""
echo "================================================================"
echo -e "${YELLOW}  Press Ctrl-C to tear everything down${NC}"
echo "================================================================"
echo ""

# Wait indefinitely (tail Next.js log to keep it visible)
tail -f "$WORKDIR/server-${WORLD}.log"
