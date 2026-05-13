import { start } from "workflow/api";
import { webhookWithDynamicResponse } from "../../../workflows/m-webhook-dynamic-response.js";
import { NextResponse } from "next/server.js";

export async function POST(_request: Request) {
  const run = await start(webhookWithDynamicResponse);
  const result = await run.returnValue;
  return NextResponse.json({ runId: run.runId, result });
}
