import { NextResponse } from "next/server.js";
import { approvalHook } from "../../../workflows/o-typed-hooks.js";

export async function POST(request: Request) {
  const body = (await request.json()) as {
    documentId?: string;
    requestId?: string;
    approved?: boolean;
    approvedBy?: string;
    comment?: string;
  };

  const documentId = body.documentId ?? "doc-123";
  const { requestId, approved, approvedBy, comment } = body;

  try {
    // The schema validates the payload before resuming the workflow.
    await approvalHook.resume(`approval:${documentId}`, {
      requestId: requestId ?? "req-1",
      approved: approved ?? true,
      approvedBy: approvedBy ?? "alice",
      comment: comment ?? "looks good",
    });
    return new NextResponse("OK");
  } catch {
    return NextResponse.json(
      { error: "Invalid token or validation failed" },
      { status: 400 }
    );
  }
}
