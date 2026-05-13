import { start } from "workflow/api";
import { manualDisposalWorkflow } from "../../../workflows/l-manual-hook-disposal.js";
import { NextResponse } from "next/server.js";

export async function POST(_request: Request) {
  const channelId = "channel123";
  const run = await start(manualDisposalWorkflow, [channelId]);
  const result = await run.returnValue;
  return NextResponse.json({ runId: run.runId, result });
}
