import { approvalHook } from "../../../workflows/user-signup.js";
import { NextResponse } from "next/server.js";

// Resume the approval hook from an API route
export async function PUT(request: Request) {
  const { token, approved, comment } = (await request.json()) as {
    token: string;
    approved: boolean;
    comment: string;
  };

  console.info(JSON.stringify(approvalHook))

  await approvalHook.resume(token, { approved, comment });

  return NextResponse.json({
    message: "Approval hook resumed",
  });
}
