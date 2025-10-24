import { start } from "workflow/api";
import { handleUserSignup } from "../../../workflows/user-signup.js";
import { NextResponse } from "next/server.js";

export async function POST(request: Request) {
  const { email } = (await request.json()) as { email: string };

  const run = await start(handleUserSignup, [email]);

  return NextResponse.json({
    message: "User signup workflow started",
    runId: run.runId,
  });
}

