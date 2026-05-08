import { start } from "workflow/api";
import { resumableStreamWorkflow } from "../../../workflows/q-streaming-resume.js";
import { NextResponse } from "next/server.js";

export async function POST() {
  const run = await start(resumableStreamWorkflow);

  return NextResponse.json({
    message:
      "Workflow started. GET /api/q-streaming-resume/<runId>?startIndex=N to read the stream.",
    runId: run.runId,
  });
}
