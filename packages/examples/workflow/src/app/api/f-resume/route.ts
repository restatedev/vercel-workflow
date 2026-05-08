import { resumeHook } from "workflow/api";
import { NextResponse } from "next/server.js";

// In an API route or external handler
export async function POST(request: Request) {
  const { token, approved, comment } = (await request.json()) as {token: string, approved: boolean, comment: string};
  try {
    // Resume the workflow with the approval data
    const result = await resumeHook(token, { approved, comment });
    return NextResponse.json({ success: true, runId: result.runId });
  } catch (error) {
    return NextResponse.json({ error });
  }
}
