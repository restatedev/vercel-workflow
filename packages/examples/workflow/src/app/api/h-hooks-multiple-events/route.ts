import { start } from "workflow/api";
import { dataCollectionWorkflow } from "../../../workflows/h-hooks-multiple-events.js";
import { NextResponse } from "next/server.js";

export async function POST(_request: Request) {
  const run = await start(dataCollectionWorkflow);

  return NextResponse.json({
    message:
      "Workflow started. The hook token is printed in dev-server logs. POST {token, value, done?} to /api/h-resume — send {done: true} to finish.",
    runId: run.runId,
  });
}
