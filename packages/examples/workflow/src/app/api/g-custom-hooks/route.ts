import { start } from "workflow/api";
import { slackChannelBot } from "../../../workflows/g-custom-hooks.js";
import { NextResponse } from "next/server.js";

export async function POST(_request: Request) {
  // Start the workflow
  const run = await start(slackChannelBot, ["channel123"]);

  return NextResponse.json({
    message: "Workflow started",
    runId: run.runId,
  });
}