import { NextResponse, NextRequest } from "next/server.js";
import { getRun } from "workflow/api";

interface RouteParams {
  params: Promise<{
    runId: string;
  }>;
}

export async function POST(_request: NextRequest, { params }: RouteParams) {
  const { runId } = await params;

  const run = getRun(runId);
  await run.restart();

  return NextResponse.json({
    message: "Workflow restarted",
    runId: run.runId,
  });
}