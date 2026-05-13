import { start } from "workflow/api";
import { webhookWorkflow } from "../../../workflows/j-webhooks.js";
import { NextResponse } from "next/server.js";

export async function POST(_request: Request) {
  const run = await start(webhookWorkflow);
  const result = await run.returnValue;
  return NextResponse.json({ runId: run.runId, result });
}
