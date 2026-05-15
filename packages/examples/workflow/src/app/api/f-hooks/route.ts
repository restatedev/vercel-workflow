import { start } from "workflow/api";
import { approvalWorkflow } from "../../../workflows/f-hooks.js";
import { NextResponse } from "next/server.js";

export async function POST(_request: Request) {
  const run = await start(approvalWorkflow);
  const result = await run.returnValue;
  return NextResponse.json({ runId: run.runId, result });
}
