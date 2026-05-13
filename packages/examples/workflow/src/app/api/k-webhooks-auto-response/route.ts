import { start } from "workflow/api";
import { webhookWithStaticResponse } from "../../../workflows/k-webhooks-auto-response.js";
import { NextResponse } from "next/server.js";

export async function POST(_request: Request) {
  const run = await start(webhookWithStaticResponse);
  const result = await run.returnValue;
  return NextResponse.json({ runId: run.runId, result });
}
