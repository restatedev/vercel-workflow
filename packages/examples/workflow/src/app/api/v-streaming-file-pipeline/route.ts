import { start } from "workflow/api";
import { fileProcessingWorkflow } from "../../../workflows/v-streaming-file-pipeline.js";
import { NextResponse } from "next/server.js";

export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as { fileUrl?: string };
  // 1KB of random bytes from httpbin makes this testable without local files.
  const fileUrl = body.fileUrl ?? "https://httpbin.org/bytes/1024";

  const run = await start(fileProcessingWorkflow, [fileUrl]);
  await run.returnValue;

  return NextResponse.json({ status: "complete", runId: run.runId });
}
