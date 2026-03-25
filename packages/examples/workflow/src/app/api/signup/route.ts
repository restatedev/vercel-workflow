import { start } from "workflow/api";
import { handleSignup } from "../../../workflows/user-signup.js";
import { NextResponse } from "next/server.js";

export async function POST(request: Request) {
  const { email } = (await request.json()) as { email: string };

  const run = await start(handleSignup, [email]);

  const result = await run.returnValue

  return NextResponse.json({
    message: "User signup workflow started",
    result: result,
  });
}