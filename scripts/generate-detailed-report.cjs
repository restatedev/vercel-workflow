#!/usr/bin/env node

// Generate a detailed Markdown report from a vitest e2e JSON + script log + dev server log.
// For each failed test: location in upstream's e2e.test.ts, the workflow under test,
// vitest error, and a server log excerpt for the run ID involved.
//
// Usage:
//   node scripts/generate-detailed-report.cjs <results.json> <run-log> <server-log> [<upstream-root>] > report.md

const fs = require("fs");
const path = require("path");

const [, , resultsPath, runLogPath, serverLogPath, upstreamRoot] =
  process.argv;
const UPSTREAM = upstreamRoot || ".upstream";

if (!resultsPath || !runLogPath || !serverLogPath) {
  console.error(
    "Usage: generate-detailed-report.cjs <results.json> <run-log> <server-log> [<upstream-root>]"
  );
  process.exit(1);
}

const E2E_TEST_FILE = path.join(UPSTREAM, "packages/core/e2e/e2e.test.ts");
const WORKFLOW_FILE = path.join(
  UPSTREAM,
  "workbench/nextjs-turbopack/workflows/99_e2e.ts"
);
const REPO_URL = "https://github.com/vercel/workflow/blob/main";

const results = JSON.parse(fs.readFileSync(resultsPath, "utf8"));
const runLog = fs.readFileSync(runLogPath, "utf8");
const serverLog = fs.readFileSync(serverLogPath, "utf8");
const e2eSource = fs.existsSync(E2E_TEST_FILE)
  ? fs.readFileSync(E2E_TEST_FILE, "utf8").split("\n")
  : [];
const workflowSource = fs.existsSync(WORKFLOW_FILE)
  ? fs.readFileSync(WORKFLOW_FILE, "utf8").split("\n")
  : [];

// ---------------------------------------------------------------------------
// Build a map: test title → line number in e2e.test.ts (best-effort regex)
// ---------------------------------------------------------------------------
function findTestLine(title) {
  // Try exact title, then title up to first " - " (vitest test names sometimes
  // include subtitle separated by " - ").
  const candidates = [title];
  const dash = title.indexOf(" - ");
  if (dash > 0) candidates.push(title.slice(0, dash));

  // Find line containing the title in quotes/backticks, where a `test(` /
  // `it(` opens within 6 lines above (handles multi-line test() calls and
  // test.each([...])('title', ...) parameterized forms).
  for (const cand of candidates) {
    const escaped = cand.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const titleRe = new RegExp(`(?:[\`'"])${escaped}(?:[\`'"])`);
    for (let i = 0; i < e2eSource.length; i++) {
      if (!titleRe.test(e2eSource[i])) continue;
      // Look up to 6 lines above for an opening test/it/test.each(
      for (let j = i; j >= Math.max(0, i - 6); j--) {
        if (/\b(test|it)(\.\w+)?\s*\(/.test(e2eSource[j])) return j + 1;
      }
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Map workflow name → line number in 99_e2e.ts
// ---------------------------------------------------------------------------
function findWorkflowLine(workflowName) {
  if (!workflowName) return null;
  const escaped = workflowName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(
    `(export\\s+)?(async\\s+)?function\\s+${escaped}\\b|export\\s+const\\s+${escaped}\\s*=`
  );
  for (let i = 0; i < workflowSource.length; i++) {
    if (re.test(workflowSource[i])) return i + 1;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Parse the run log into per-test diagnostic blocks
//   ━━━ Workflow Run Diagnostics ━━━
//   Run ID:     wrun_...
//   Status:     ...
//   Workflow:   workflow//.../99_e2e//xxxWorkflow
//   ...
//   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Diagnostics blocks immediately follow `stderr | ... > <test-name>` lines.
// ---------------------------------------------------------------------------
function stripAnsi(s) {
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}

function parseDiagnostics() {
  const lines = stripAnsi(runLog).split("\n");
  const blocks = []; // { testName, runId, status, workflow, error, raw }
  let currentTest = null;
  let inBlock = false;
  let block = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const stderrMatch = line.match(/^stderr \| .* > e2e > (.+?)$/);
    if (stderrMatch) {
      currentTest = stderrMatch[1].trim();
      continue;
    }
    if (line.startsWith("━━━ Workflow Run Diagnostics")) {
      inBlock = true;
      block = { testName: currentTest, raw: [] };
      continue;
    }
    if (inBlock) {
      if (/^━━━+$/.test(line.trim())) {
        if (block) blocks.push(block);
        inBlock = false;
        block = null;
        continue;
      }
      block.raw.push(line);
      const kv = line.match(/^\s*(\w[\w ]*?):\s+(.*)$/);
      if (kv) {
        const k = kv[1].trim().toLowerCase().replace(/\s+/g, "_");
        block[k] = kv[2].trim();
      }
    }
  }
  return blocks;
}

const diagnostics = parseDiagnostics();

// Group diagnostics by test name
const diagByTest = new Map();
for (const d of diagnostics) {
  if (!d.testName) continue;
  if (!diagByTest.has(d.testName)) diagByTest.set(d.testName, []);
  diagByTest.get(d.testName).push(d);
}

// ---------------------------------------------------------------------------
// Pull server log excerpts for a given runId
// ---------------------------------------------------------------------------
const serverLines = stripAnsi(serverLog).split("\n");

function serverExcerptForRunId(runId, max = 12) {
  if (!runId) return [];
  // Find the last few mentions of this runId, plus any error/warn lines on
  // the same workflow context.
  const matches = [];
  for (let i = 0; i < serverLines.length; i++) {
    const line = serverLines[i];
    if (line.includes(runId)) {
      matches.push(line);
    }
  }
  // Also pull lines that mention WARN/ERROR around any of the matches
  return matches.slice(-max);
}

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------
const all = [];
for (const file of results.testResults || []) {
  for (const t of file.assertionResults || []) {
    all.push(t);
  }
}
const passed = all.filter((t) => t.status === "passed");
const failed = all.filter((t) => t.status === "failed");

const out = [];
out.push("# Restate × Vercel Workflow — Detailed E2E Report");
out.push("");
out.push(
  `**Total:** ${results.numTotalTests}  |  **Passed:** ${results.numPassedTests}  |  **Failed:** ${results.numFailedTests}  |  **Suites passed:** ${results.numPassedTestSuites}/${results.numTotalTestSuites}`
);
out.push("");
out.push(
  "_Source paths assume the upstream `vercel/workflow` checkout under `.upstream/`._"
);
out.push("");

// ---- Passed -----------------------------------------------------------
out.push("## Passed");
out.push("");
out.push("| Test | Source |");
out.push("|---|---|");
for (const t of passed) {
  const line = findTestLine(t.title);
  const src = line
    ? `[e2e.test.ts:${line}](${REPO_URL}/packages/core/e2e/e2e.test.ts#L${line})`
    : "—";
  out.push(`| \`${t.title}\` | ${src} |`);
}
out.push("");

// ---- Failed -----------------------------------------------------------
out.push("## Failed");
out.push("");

for (const t of failed) {
  const testLine = findTestLine(t.title);
  const testLink = testLine
    ? `[e2e.test.ts:${testLine}](${REPO_URL}/packages/core/e2e/e2e.test.ts#L${testLine})`
    : "_test location not found_";
  out.push(`### \`${t.fullName}\``);
  out.push("");
  out.push(`- **Test source:** ${testLink}`);

  // Match diagnostics by title, then try the part before " - " (vitest sometimes
  // appends a subtitle to t.title that's separated from the workbench-side name).
  const diagKeys = [t.title];
  const dashIdx = t.title.indexOf(" - ");
  if (dashIdx > 0) diagKeys.push(t.title.slice(0, dashIdx));
  let diags = [];
  for (const k of diagKeys) {
    if (diagByTest.has(k)) {
      diags = diagByTest.get(k);
      break;
    }
  }
  const workflowFnNames = new Set();
  for (const d of diags) {
    const m = (d.workflow || "").match(/workflow\/\/.*\/\/([\w$]+)/);
    if (m) workflowFnNames.add(m[1]);
  }
  for (const fnName of workflowFnNames) {
    const wfLine = findWorkflowLine(fnName);
    if (wfLine) {
      out.push(
        `- **Workflow under test:** \`${fnName}\` ([99_e2e.ts:${wfLine}](${REPO_URL}/workbench/nextjs-turbopack/workflows/99_e2e.ts#L${wfLine}))`
      );
    } else {
      out.push(`- **Workflow under test:** \`${fnName}\``);
    }
  }

  // Vitest error (compact). When it's STACK_TRACE_ERROR, the real cause is in
  // the diagnostics block — we still show the headline so the reader sees it.
  if (t.failureMessages?.length) {
    const firstMsg = t.failureMessages[0] || "";
    const headline = firstMsg.split("\n")[0].slice(0, 200);
    out.push(`- **Vitest headline:** \`${headline}\``);
    if (firstMsg.includes("STACK_TRACE_ERROR")) {
      out.push(
        "  > _vitest reports `STACK_TRACE_ERROR` when a test throws inside an async helper; see Workflow Run Diagnostics below for the real cause._"
      );
    }
  }

  // Diagnostics blocks
  if (diags.length) {
    out.push("- **Workflow Run Diagnostics:**");
    out.push("  ```");
    for (const d of diags.slice(-2)) {
      // last two
      if (d.run_id) out.push(`  Run ID:    ${d.run_id}`);
      if (d.status) out.push(`  Status:    ${d.status}`);
      if (d.workflow) out.push(`  Workflow:  ${d.workflow}`);
      if (d.error) out.push(`  Error:     ${d.error}`);
      out.push("  ");
    }
    out.push("  ```");

    // Server log excerpt for run ID
    const runIds = [...new Set(diags.map((d) => d.run_id).filter(Boolean))];
    for (const runId of runIds.slice(-1)) {
      const excerpt = serverExcerptForRunId(runId, 8);
      if (excerpt.length) {
        out.push(`- **Server log (last ${excerpt.length} lines for ${runId}):**`);
        out.push("  ```");
        for (const line of excerpt) out.push("  " + line.slice(0, 240));
        out.push("  ```");
      }
    }
  }
  out.push("");
}

console.log(out.join("\n"));
