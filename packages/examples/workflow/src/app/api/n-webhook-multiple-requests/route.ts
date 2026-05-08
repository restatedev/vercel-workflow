import { start } from "workflow/api";
import { eventCollectorWorkflow } from "../../../workflows/n-webhook-multiple-requests.js";
import { NextResponse } from "next/server.js";

export async function POST(_request: Request) {
  const run = await start(eventCollectorWorkflow);

  return NextResponse.json({
    message:
      "Workflow started. Check the dev server logs for the webhook URL. POST events to it; send {\"type\":\"done\"} to finish.",
    runId: run.runId,
  });
}
