import { start } from "workflow/api";
import { streamErrorWorkflow } from "../../../workflows/w-streaming-errors.js";
import { NextResponse } from "next/server.js";

export async function POST() {
  const run = await start(streamErrorWorkflow);

  // We expect this workflow to fail with FatalError — surface that to the caller.
  try {
    await run.returnValue;
    return NextResponse.json({ runId: run.runId, status: "completed" });
  } catch (error) {
    return NextResponse.json({
      runId: run.runId,
      status: "failed",
      error: String(error),
    });
  }
}
