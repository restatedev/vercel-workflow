import { start } from "workflow/api";
import { webhookWithStaticResponse } from "../../../workflows/k-webhooks-auto-response.js";
import { NextResponse } from "next/server.js";

export async function POST(_request: Request) {
  const run = await start(webhookWithStaticResponse);

  return NextResponse.json({
    message:
      "Workflow started. The webhook URL is printed in the dev-server logs. POSTing to it returns a static {success:true} response automatically.",
    runId: run.runId,
  });
}
