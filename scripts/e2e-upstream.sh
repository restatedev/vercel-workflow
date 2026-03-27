#!/usr/bin/env bash
set -euo pipefail

# ---------------------------------------------------------------------------
# Run upstream vercel/workflow e2e tests against a world implementation.
#
# Usage:
#   ./scripts/e2e-upstream.sh <world>         # restate | mongodb | redis
#   ./scripts/e2e-upstream.sh restate         # test Restate world (builds local package)
#   ./scripts/e2e-upstream.sh mongodb         # test MongoDB world (from npm)
#   ./scripts/e2e-upstream.sh redis           # test Redis world (from npm)
#
# Environment variables:
#   UPSTREAM_REF    - git ref to clone (default: main)
#   WORKDIR         - where to clone upstream (default: .upstream)
#   CLEAN           - set to "1" to force re-clone
# ---------------------------------------------------------------------------

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WORLD="${1:-}"
UPSTREAM_REF="${UPSTREAM_REF:-main}"
WORKDIR="${WORKDIR:-$REPO_ROOT/.upstream}"
APP_NAME="nextjs-turbopack"

# --- Colors ---
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
BLUE='\033[0;34m'
NC='\033[0m'

log()      { echo -e "${BLUE}==>${NC} $*"; }
log_ok()   { echo -e "${GREEN}==>${NC} $*"; }
log_warn() { echo -e "${YELLOW}==>${NC} $*"; }
log_err()  { echo -e "${RED}==>${NC} $*"; }

# --- Validate args ---
if [[ -z "$WORLD" ]]; then
  echo "Usage: $0 <world>"
  echo "  Worlds: restate, mongodb, redis"
  exit 1
fi

# --- World-specific configuration (Bash 3 compatible) ---
world_config() {
  local key="$1"
  case "$WORLD/$key" in
    restate/package)        echo "local" ;;
    mongodb/package)        echo "@workflow-worlds/mongodb" ;;
    redis/package)          echo "@workflow-worlds/redis" ;;

    restate/docker_image)   echo "docker.io/restatedev/restate:1.5.3" ;;
    mongodb/docker_image)   echo "mongo:7" ;;
    redis/docker_image)     echo "redis:7-alpine" ;;

    restate/docker_ports)   echo "-p 8080:8080 -p 9070:9070" ;;
    mongodb/docker_ports)   echo "-p 27017:27017" ;;
    redis/docker_ports)     echo "-p 6379:6379" ;;

    restate/docker_name)    echo "restate-e2e" ;;
    mongodb/docker_name)    echo "mongodb-e2e" ;;
    redis/docker_name)      echo "redis-e2e" ;;

    restate/health_cmd)     echo "curl -sf http://localhost:9070/health" ;;
    mongodb/health_cmd)     echo "docker exec mongodb-e2e mongosh --eval 'db.runCommand(\"ping\").ok' 2>/dev/null" ;;
    redis/health_cmd)       echo "docker exec redis-e2e redis-cli ping 2>/dev/null | grep -q PONG" ;;

    *)
      log_err "Unknown world/key: $WORLD/$key"
      exit 1
      ;;
  esac
}

# Validate world name
world_config package > /dev/null

# --- Cleanup handler ---
DOCKER_CONTAINER="$(world_config docker_name)"
DEV_PID=""

cleanup() {
  log "Cleaning up..."
  [[ -n "$DEV_PID" ]] && kill "$DEV_PID" 2>/dev/null || true
  docker rm -f "$DOCKER_CONTAINER" 2>/dev/null || true
}
trap cleanup EXIT

# --- Step 1: Build local package (Restate only) ---
TARBALL_PATH=""
if [[ "$WORLD" == "restate" ]]; then
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
fi

# --- Step 2: Clone upstream ---
if [[ "${CLEAN:-}" == "1" ]] || [[ ! -d "$WORKDIR" ]]; then
  log "Cloning upstream vercel/workflow @ $UPSTREAM_REF..."
  rm -rf "$WORKDIR"
  git clone --depth 1 --branch "$UPSTREAM_REF" https://github.com/vercel/workflow.git "$WORKDIR"
else
  log "Using existing upstream at $WORKDIR (set CLEAN=1 to force re-clone)"
fi

cd "$WORKDIR"

# --- Step 3: Install upstream dependencies ---
log "Installing upstream dependencies..."
UPSTREAM_PNPM_VERSION=$(node -e "const pm = require('./package.json').packageManager || ''; console.log(pm.split('@')[1] || '10.14.0')")
log "Upstream pnpm version: $UPSTREAM_PNPM_VERSION"

# Use upstream's pnpm version
npm i -g "pnpm@${UPSTREAM_PNPM_VERSION}" 2>/dev/null || true
pnpm install --frozen-lockfile

# Build upstream packages (needed so workflow/dist/next.cjs etc. exist)
log "Building upstream packages..."
pnpm turbo run build --filter='!./workbench/*'

# --- Step 4: Install world package into workbench ---
log "Installing $WORLD world into workbench..."
cd "workbench/$APP_NAME"

if [[ "$WORLD" == "restate" ]]; then
  pnpm add "$TARBALL_PATH"
else
  pnpm add "$(world_config package)"
fi

cd "$WORKDIR"

# --- Step 5: Patch workbench (Restate only) ---
if [[ "$WORLD" == "restate" ]]; then
  log "Patching workbench for Restate..."
  node "$REPO_ROOT/scripts/patch-upstream-workbench.cjs" "workbench/$APP_NAME"
  # Clear .next cache — stale cache prevents the deferred builder from generating routes
  rm -rf "workbench/$APP_NAME/.next"
fi

# --- Step 6: Resolve symlinks ---
log "Resolving symlinks..."
if [[ -f scripts/resolve-symlinks.sh ]]; then
  CI=true bash scripts/resolve-symlinks.sh "workbench/$APP_NAME"
else
  log_warn "No resolve-symlinks.sh found in upstream — skipping"
fi

# --- Step 7: Start Docker service ---
log "Starting ${WORLD} Docker container..."
docker rm -f "$DOCKER_CONTAINER" 2>/dev/null || true

DOCKER_ENV=""
if [[ "$WORLD" == "restate" ]]; then
  DOCKER_ENV="-e RESTATE_DEFAULT_RETRY_POLICY__ON_MAX_ATTEMPTS=pause"
fi

# shellcheck disable=SC2086
docker run -d --name "$DOCKER_CONTAINER" \
  $(world_config docker_ports) \
  $DOCKER_ENV \
  "$(world_config docker_image)"

log "Waiting for ${WORLD} to be ready..."
HEALTH_CMD="$(world_config health_cmd)"
for i in $(seq 1 30); do
  if eval "$HEALTH_CMD" > /dev/null 2>&1; then
    log_ok "${WORLD} is ready"
    break
  fi
  if [[ "$i" -eq 30 ]]; then
    log_err "${WORLD} failed to start"
    exit 1
  fi
  sleep 2
done

# --- Step 8: Set environment variables ---
export WORKFLOW_PUBLIC_MANIFEST=1
export DEPLOYMENT_URL="http://localhost:3000"
export WORKFLOW_SERVICE_URL="http://localhost:3000"
export NODE_OPTIONS="--enable-source-maps"
export APP_NAME="$APP_NAME"

case "$WORLD" in
  restate)
    export RESTATE_INGRESS="http://localhost:8080"
    ;;
  mongodb)
    export WORKFLOW_TARGET_WORLD="@workflow-worlds/mongodb"
    export WORKFLOW_MONGODB_URI="mongodb://localhost:27017"
    export WORKFLOW_MONGODB_DATABASE_NAME="workflow"
    ;;
  redis)
    export WORKFLOW_TARGET_WORLD="@workflow-worlds/redis"
    export WORKFLOW_REDIS_URI="redis://localhost:6379"
    ;;
esac

# --- Step 9: Start dev server ---
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

# --- Step 10: Register with Restate (Restate only) ---
if [[ "$WORLD" == "restate" ]]; then
  # Detect Docker host address
  if [[ "$(uname)" == "Darwin" ]]; then
    DOCKER_HOST_ADDR="host.docker.internal"
  else
    DOCKER_HOST_ADDR="localhost"
  fi

  log "Warming up .restate-well-known route (Turbopack compiles on-demand)..."
  curl -s "http://localhost:3000/.restate-well-known" -o /dev/null || true
  sleep 10

  log "Registering dev server with Restate..."
  for attempt in $(seq 1 5); do
    if curl -f -X POST http://localhost:9070/deployments \
      -H 'content-type: application/json' \
      -d "{\"uri\": \"http://${DOCKER_HOST_ADDR}:3000/.restate-well-known\"}" 2>&1; then
      echo ""
      log_ok "Registered with Restate"
      break
    fi
    echo ""
    log_warn "Registration attempt $attempt failed, retrying in 5s..."
    sleep 5
  done
fi

# --- Step 11: Run e2e tests ---
log "Running upstream e2e tests for ${WORLD}..."
EXIT_CODE=0
pnpm vitest run packages/core/e2e/e2e.test.ts \
  --reporter=default --reporter=json \
  --outputFile="e2e-${WORLD}.json" \
  || EXIT_CODE=$?

if [[ "$EXIT_CODE" -eq 0 ]]; then
  log_ok "All e2e tests passed!"
else
  log_warn "Some e2e tests failed (exit code: $EXIT_CODE)"
  log "Server logs: $WORKDIR/server-${WORLD}.log"
  log "Results: $WORKDIR/e2e-${WORLD}.json"
fi

exit "$EXIT_CODE"
