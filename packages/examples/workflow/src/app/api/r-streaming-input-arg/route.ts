import { start } from "workflow/api";
import { streamProcessingWorkflow } from "../../../workflows/r-streaming-input-arg.js";
import { NextResponse } from "next/server.js";

export async function POST(request: Request) {
  if (!request.body) {
    return NextResponse.json(
      { error: "Missing request body" },
      { status: 400 }
    );
  }

  const run = await start(streamProcessingWorkflow, [request.body]);
  const result = await run.returnValue;

  return NextResponse.json({
    status: "complete",
    runId: run.runId,
    result,
  });
}
