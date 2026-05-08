import { start } from "workflow/api";
import { webhookWithDynamicResponse } from "../../../workflows/m-webhook-dynamic-response.js";
import { NextResponse } from "next/server.js";

export async function POST(_request: Request) {
  const run = await start(webhookWithDynamicResponse);

  return NextResponse.json({
    message:
      "Workflow started. Check the dev server logs for the webhook URL, then POST {\"type\":\"urgent\"} or {\"type\":\"normal\"} to it.",
    runId: run.runId,
  });
}
