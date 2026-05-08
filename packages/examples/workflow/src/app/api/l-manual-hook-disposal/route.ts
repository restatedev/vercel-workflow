import { start } from "workflow/api";
import { manualDisposalWorkflow } from "../../../workflows/l-manual-hook-disposal.js";
import { NextResponse } from "next/server.js";

export async function POST(_request: Request) {
  const channelId = "channel123";
  const run = await start(manualDisposalWorkflow, [channelId]);

  return NextResponse.json({
    message: "Workflow started. Send a payload to /api/l-resume to continue.",
    runId: run.runId,
    token: `channel:${channelId}`,
  });
}
