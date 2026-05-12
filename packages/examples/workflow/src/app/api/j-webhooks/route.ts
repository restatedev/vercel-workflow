import { start } from "workflow/api";
import { webhookWorkflow } from "../../../workflows/j-webhooks.js";
import { NextResponse } from "next/server.js";

export async function POST(_request: Request) {
  const run = await start(webhookWorkflow);

  return NextResponse.json({
    message:
      "Workflow started. The webhook URL is printed in the dev-server logs — POST any JSON to it to resume the workflow.",
    runId: run.runId,
  });
}
