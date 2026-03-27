#!/usr/bin/env node

// Reads vitest JSON results from e2e test runs and generates a Markdown summary.
// Usage: node aggregate-e2e-results.cjs <results-dir> [--run-url <url>]

const fs = require("fs");
const path = require("path");

const args = process.argv.slice(2);
const resultsDir = args[0];
const runUrlIdx = args.indexOf("--run-url");
const runUrl = runUrlIdx !== -1 ? args[runUrlIdx + 1] : undefined;

if (!resultsDir) {
  console.error("Usage: node aggregate-e2e-results.cjs <results-dir> [--run-url <url>]");
  process.exit(1);
}

// World display names
const WORLD_NAMES = {
  restate: "Restate",
  mongodb: "MongoDB",
  redis: "Redis",
  turso: "Turso",
  starter: "Starter",
};

// ---------------------------------------------------------------------------
// Parse results
// ---------------------------------------------------------------------------

const worldResults = [];

function findJsonFiles(dir) {
  const files = [];
  if (!fs.existsSync(dir)) return files;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...findJsonFiles(fullPath));
    } else if (entry.name.match(/^e2e-.*\.json$/)) {
      files.push(fullPath);
    }
  }
  return files;
}

const jsonFiles = findJsonFiles(resultsDir);

for (const file of jsonFiles) {
  let data;
  try {
    data = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    continue;
  }

  // Extract world name from filename: e2e-restate.json → restate
  const basename = path.basename(file, ".json");
  const worldId = basename.replace(/^e2e-/, "");
  const worldName = WORLD_NAMES[worldId] || worldId;

  const tests = [];

  function extractTests(suite) {
    if (suite.assertionResults) {
      for (const test of suite.assertionResults) {
        tests.push({
          name:
            test.fullName ||
            [...(test.ancestorTitles || []), test.title].join(" > "),
          status: test.status, // passed, failed, pending
          duration: test.duration || 0,
          failureMessages: test.failureMessages || [],
        });
      }
    }
    if (suite.suites) {
      for (const sub of suite.suites) extractTests(sub);
    }
  }

  if (data.testResults) {
    for (const file of data.testResults) extractTests(file);
  }

  const passed = tests.filter((t) => t.status === "passed").length;
  const failed = tests.filter((t) => t.status === "failed").length;
  const skipped = tests.filter((t) => t.status === "pending").length;
  const duration = (data.testResults || []).reduce(
    (acc, r) => acc + (r.endTime - r.startTime),
    0
  );

  worldResults.push({ worldId, worldName, tests, passed, failed, skipped, duration });
}

if (worldResults.length === 0) {
  const md = `## E2E Test Results\n\nNo test results found.${runUrl ? ` [View workflow run](${runUrl})` : ""}\n`;
  fs.writeFileSync(path.join(resultsDir, "e2e-summary.md"), md);
  console.log(md);
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Generate Markdown
// ---------------------------------------------------------------------------

// Sort: failures first, then by name
worldResults.sort((a, b) => {
  if (a.failed !== b.failed) return b.failed - a.failed;
  return a.worldName.localeCompare(b.worldName);
});

const totalPassed = worldResults.reduce((s, r) => s + r.passed, 0);
const totalFailed = worldResults.reduce((s, r) => s + r.failed, 0);
const allPassing = totalFailed === 0;

let md = `## ${allPassing ? "✅" : "⚠️"} E2E Test Results\n\n`;

md += `| World | Passed | Failed | Skipped | Duration |\n`;
md += `|-------|--------|--------|---------|----------|\n`;

for (const r of worldResults) {
  const status = r.failed === 0 ? "✅" : "❌";
  const dur = (r.duration / 1000).toFixed(1) + "s";
  md += `| ${status} ${r.worldName} | ${r.passed} | ${r.failed} | ${r.skipped} | ${dur} |\n`;
}

md += "\n";

// Detail failed tests per world
for (const r of worldResults) {
  const failures = r.tests.filter((t) => t.status === "failed");
  if (failures.length === 0) continue;

  md += `### ${r.worldName} — ${failures.length} failure${failures.length !== 1 ? "s" : ""}\n\n`;
  md += "<details><summary>Show failed tests</summary>\n\n";
  for (const f of failures) {
    const msg = f.failureMessages[0]
      ? `: ${f.failureMessages[0].split("\n")[0].slice(0, 200)}`
      : "";
    md += `- \`${f.name}\`${msg}\n`;
  }
  md += "\n</details>\n\n";
}

if (runUrl) {
  md += `[View workflow run](${runUrl})\n`;
}

// Write output
fs.writeFileSync(path.join(resultsDir, "e2e-summary.md"), md);
console.log(md);

if (totalFailed > 0) {
  process.exit(1);
}
