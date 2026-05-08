import { start } from "workflow/api";
import { approvalWorkflow } from "../../../workflows/f-hooks.js";
import { NextResponse } from "next/server.js";

export async function POST(_request: Request) {
  // Start the workflow
  const run = await start(approvalWorkflow);

  return NextResponse.json({
    message: "Workflow started",
    runId: run.runId,
  });
}