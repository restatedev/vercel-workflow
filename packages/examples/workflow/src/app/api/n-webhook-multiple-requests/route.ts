import { start } from "workflow/api";
import { eventCollectorWorkflow } from "../../../workflows/n-webhook-multiple-requests.js";
import { NextResponse } from "next/server.js";

export async function POST(_request: Request) {
  const run = await start(eventCollectorWorkflow);
  const result = await run.returnValue;
  return NextResponse.json({ runId: run.runId, result });
}
