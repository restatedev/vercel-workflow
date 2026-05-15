import { start } from "workflow/api";
import { documentApprovalWorkflow } from "../../../workflows/o-typed-hooks.js";
import { NextResponse } from "next/server.js";

export async function POST(request: Request) {
  const { documentId } = (await request.json().catch(() => ({}))) as {
    documentId?: string;
  };
  const id = documentId ?? "doc-123";
  const run = await start(documentApprovalWorkflow, [id]);
  const result = await run.returnValue;
  return NextResponse.json({ runId: run.runId, result });
}
