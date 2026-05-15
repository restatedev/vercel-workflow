import { defineConfig } from "vitest/config";

// Dedicated config for the vendored upstream e2e suite.
// Run via `pnpm test:e2e` from this package, or `scripts/e2e.sh` from the repo root.
// Requires a running Restate server, a running examples dev server, and
// DEPLOYMENT_URL / RESTATE_INGRESS / RESTATE_ADMIN_URL / WORKFLOW_TARGET_WORLD in env.
export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["e2e/**/*.test.ts"],
    testTimeout: 60_000,
    hookTimeout: 30_000,
    // The e2e suite is heavy; force a single worker so runs don't race for the
    // shared Restate server / dev server resources.
    fileParallelism: false,
    pool: "forks",
    poolOptions: {
      forks: { singleFork: true },
    },
  },
});
