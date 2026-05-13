#!/usr/bin/env node
/**
 * Build a vitest `-t` regex pattern that matches only tests that FAILED in
 * the most recent e2e run.
 *
 * Usage:
 *   node scripts/e2e-failed-pattern.cjs                       # use e2e-reports/run4-results.json
 *   node scripts/e2e-failed-pattern.cjs e2e-reports/run3-results.json
 *
 * Combined with e2e-upstream.sh:
 *   TESTS_FILTER="$(node scripts/e2e-failed-pattern.cjs)" \
 *     ./scripts/e2e-upstream.sh restate
 */
const fs = require("node:fs");
const path = require("node:path");

const file = process.argv[2] ?? "e2e-reports/run4-results.json";
const abs = path.resolve(process.cwd(), file);
if (!fs.existsSync(abs)) {
  console.error(`results file not found: ${abs}`);
  process.exit(1);
}

const data = JSON.parse(fs.readFileSync(abs, "utf8"));
const failed = [];
for (const f of data.testResults ?? []) {
  for (const t of f.assertionResults ?? []) {
    if (t.status === "failed") {
      // vitest -t matches against the leaf test title (not the full path).
      // Use `.title` which is just the test() name without describe() prefixes.
      failed.push(t.title);
    }
  }
}

if (failed.length === 0) {
  console.error("no failed tests found in results");
  process.exit(2);
}

// Escape regex metacharacters so the pattern matches the test titles literally.
// vitest -t does a substring/regex match against the full task path (including
// describe segments), so we *don't* anchor with ^...$. Just an alternation.
const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const pattern = "(" + failed.map(escape).join("|") + ")";
process.stdout.write(pattern);
