import { start } from "workflow/api";
import { streamPipelineWorkflow } from "../../../workflows/u-streaming-between-steps.js";
import { NextResponse } from "next/server.js";

export async function POST() {
  const run = await start(streamPipelineWorkflow);
  const result = await run.returnValue;

  return NextResponse.json({ runId: run.runId, result });
}
