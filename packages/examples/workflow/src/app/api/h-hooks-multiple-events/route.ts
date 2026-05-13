import { start } from "workflow/api";
import { dataCollectionWorkflow } from "../../../workflows/h-hooks-multiple-events.js";
import { NextResponse } from "next/server.js";

export async function POST(_request: Request) {
  const run = await start(dataCollectionWorkflow);
  const result = await run.returnValue;
  return NextResponse.json({ runId: run.runId, result });
}
