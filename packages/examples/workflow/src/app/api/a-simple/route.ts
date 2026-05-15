import { start } from "workflow/api";
import { calculateWorkflow } from "../../../workflows/a-simple.js";
import { NextResponse } from "next/server.js";

export async function POST(_request: Request) {
  // Start the workflow
  const run = await start(calculateWorkflow, [2, 7]);

  // Check the workflow status
  const status = await run.status; // "running" | "completed" | "failed"

  // Get the workflow's return value (blocks until completion)
  const result = await run.returnValue;

  return NextResponse.json({
    message: "Workflow started",
    runId: run.runId,
    status,
    result,
  });
}
