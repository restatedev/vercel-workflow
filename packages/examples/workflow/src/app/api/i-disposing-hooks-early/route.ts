import { start } from "workflow/api";
import { handoffWorkflow } from "../../../workflows/i-disposing-hooks-early.js";
import { NextResponse } from "next/server.js";

export async function POST(request: Request) {
  const { channelId } = (await request.json().catch(() => ({}))) as {
    channelId?: string;
  };
  const id = channelId ?? "channel123";

  const run = await start(handoffWorkflow, [id]);

  return NextResponse.json({
    message:
      "Workflow started. POST {channelId?, message, handoff?} to /api/i-resume — send {handoff: true} to release the token.",
    runId: run.runId,
    token: `channel:${id}`,
  });
}
