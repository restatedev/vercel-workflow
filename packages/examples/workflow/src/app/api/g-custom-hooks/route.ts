import { start } from "workflow/api";
import { slackChannelBot } from "../../../workflows/g-custom-hooks.js";
import { NextResponse } from "next/server.js";

export async function POST(_request: Request) {
  const run = await start(slackChannelBot, ["channel123"]);
  const result = await run.returnValue;
  return NextResponse.json({ runId: run.runId, result });
}
