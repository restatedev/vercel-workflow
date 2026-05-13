#!/usr/bin/env node
/**
 * Read an e2e-results.json + the matching run log, and emit a classified
 * Markdown table per failed test. For each failure we determine:
 *
 *   - assertion-failure  : test completed, vitest got a real assertion message
 *   - timeout-running    : vitest's "STACK_TRACE_ERROR" sentinel + workflow
 *                          still in `running` status at the diagnostic block
 *   - timeout-completed  : vitest sentinel but workflow did finish (race
 *                          between vitest timeout and run completion)
 *   - request-error      : test got a 5xx response from a route
 *   - other              : doesn't fit the above
 *
 * Usage:
 *   node scripts/e2e-classify.cjs e2e-reports/run4-results.json e2e-reports/run4.log
 */
const fs = require("node:fs");
const path = require("node:path");

const [jsonPath, logPath] = process.argv.slice(2);
if (!jsonPath || !logPath) {
  console.error(
    "Usage: node scripts/e2e-classify.cjs <results.json> <run.log>"
  );
  process.exit(1);
}

const results = JSON.parse(fs.readFileSync(jsonPath, "utf8"));
// Strip ANSI escape codes so the regexes below don't have to deal with them.
const log = fs
  .readFileSync(logPath, "utf8")
  .replace(/\[[0-9;]*m/g, "")
  .replace(/\[[0-9]+[a-zA-Z]/g, "");

// Build an index of diagnostic blocks: each block follows a vitest stderr
// line that names the test. We capture the test name -> { status, runId,
// workflow, error? }.
const diagByTest = new Map();
// `stderr | ... > e2e > <testname>` followed (after blank line) by the
// diagnostics block. The test name may be split across describe>name segments;
// take the last `> <name>` segment up to the newline.
const blockRe =
  /e2e\s*>\s*([^\n]*?)\s*\n[\s\S]{0,200}?━━━ Workflow Run Diagnostics ━━━\n([\s\S]*?)\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━/g;
let m;
while ((m = blockRe.exec(log)) !== null) {
  const testName = m[1].replace(/\[[0-9;]*m/g, "").trim();
  const block = m[2];
  const get = (k) => {
    const r = new RegExp(`^${k}:\\s*(.+?)$`, "m");
    const found = block.match(r);
    return found ? found[1].trim() : null;
  };
  const status = get("Status");
  const runId = get("Run ID");
  const workflow = get("Workflow");
  const completed = get("Completed");
  const output = get("Output");
  // Use the *last* block per test name (some tests run more than one workflow).
  diagByTest.set(testName, { status, runId, workflow, completed, output });
}

// Build runId -> first WARN/ERROR line from the log, if any.
const errorsByRunId = new Map();
{
  const re = /\[([^\]]+)\]\s+(WARN|ERROR):\s*([^\n]*)/g;
  let mm;
  while ((mm = re.exec(log)) !== null) {
    const ctx = mm[1];
    const level = mm[2];
    const msg = mm[3].trim();
    const runMatch = ctx.match(/(wrun_[A-Za-z0-9]+)/);
    if (runMatch) {
      const rid = runMatch[1];
      if (!errorsByRunId.has(rid)) {
        errorsByRunId.set(rid, `${level}: ${msg}`);
      }
    }
  }
}

const failed = [];
for (const f of results.testResults ?? []) {
  for (const t of f.assertionResults ?? []) {
    if (t.status !== "failed") continue;
    const msg = (t.failureMessages?.[0] ?? "").split("\n")[0];
    const isStack = msg.includes("STACK_TRACE_ERROR");
    const diag = diagByTest.get(t.title) ?? null;
    const wfStatus = diag?.status?.split(":")[0]?.trim() ?? null; // strip parens
    const runId = diag?.runId ?? null;
    const serverErr = runId ? errorsByRunId.get(runId) : null;

    let category, detail;
    if (isStack && diag) {
      if (
        wfStatus === "running" ||
        wfStatus?.startsWith("(failed to fetch")
      ) {
        category = "timeout-running";
        detail = `Workflow status was '${diag.status}' when vitest's 60s timer fired.${serverErr ? " Server: " + serverErr : ""}`;
      } else if (wfStatus === "completed") {
        category = "timeout-completed";
        detail = `Workflow status was 'completed' but the test still timed out — race or post-completion polling stuck.${serverErr ? " Server: " + serverErr : ""}`;
      } else {
        category = "timeout-other";
        detail = `Workflow status: ${diag.status ?? "unknown"}.${serverErr ? " Server: " + serverErr : ""}`;
      }
    } else if (isStack) {
      category = "timeout-nodiag";
      detail = "vitest STACK_TRACE_ERROR with no diagnostic block — likely test setup or HTTP layer hang.";
    } else if (/^Error:\s+Request failed:\s+5\d\d/.test(msg)) {
      category = "request-error";
      detail = msg;
    } else if (/Failed to load external module/.test(msg)) {
      category = "module-resolution";
      detail = "Next.js dev couldn't resolve a workbench module (pages-router build issue).";
    } else if (/Please set the RESTATE_ADMIN_URL/.test(msg)) {
      category = "config-missing";
      detail = msg;
    } else {
      category = "assertion-failure";
      detail = msg;
    }

    failed.push({
      name: t.title,
      category,
      detail,
      diag,
    });
  }
}

// Sort: assertion failures first (most actionable), then timeouts, then setup.
const order = [
  "assertion-failure",
  "request-error",
  "config-missing",
  "module-resolution",
  "timeout-completed",
  "timeout-running",
  "timeout-other",
  "timeout-nodiag",
];
failed.sort((a, b) => {
  const oa = order.indexOf(a.category);
  const ob = order.indexOf(b.category);
  if (oa !== ob) return oa - ob;
  return a.name.localeCompare(b.name);
});

// Group counts
const counts = new Map();
for (const f of failed) counts.set(f.category, (counts.get(f.category) ?? 0) + 1);

console.log("# Failure categories\n");
console.log("| Category | Count | Meaning |");
console.log("|---|---|---|");
const labels = {
  "assertion-failure": "Test completed, an assertion failed; the message is actionable",
  "request-error": "Test got a 5xx response from a route (likely our server)",
  "config-missing": "Test failed because of a missing env var (fix in script, not code)",
  "module-resolution": "Next.js dev couldn't resolve a workbench module (upstream issue)",
  "timeout-completed": "60s vitest timeout, but the workflow actually finished — race or polling hang",
  "timeout-running": "60s vitest timeout while workflow was still in 'running' state — workflow code hung",
  "timeout-other": "60s vitest timeout with non-standard workflow status",
  "timeout-nodiag": "60s vitest timeout with no diagnostic block — likely transport/setup hang",
};
for (const k of order) {
  if (!counts.has(k)) continue;
  console.log(`| ${k} | ${counts.get(k)} | ${labels[k] ?? ""} |`);
}
console.log();

let lastCat = null;
for (const f of failed) {
  if (f.category !== lastCat) {
    console.log(`\n## ${f.category} (${counts.get(f.category)} tests)\n`);
    lastCat = f.category;
  }
  console.log(`### \`${f.name}\``);
  console.log();
  console.log(`- **Why:** ${f.detail}`);
  if (f.diag) {
    if (f.diag.workflow)
      console.log(
        `- **Workflow:** \`${f.diag.workflow.replace(/^workflow\/\/\.\//, "").replace(/\/\//g, "/")}\``
      );
    if (f.diag.runId) console.log(`- **runId:** \`${f.diag.runId}\``);
    if (f.diag.completed) console.log(`- **completedAt:** ${f.diag.completed}`);
  }
  console.log();
}
