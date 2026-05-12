import { resumeHook } from "workflow/api";
import { NextResponse } from "next/server.js";

export async function POST(request: Request) {
  const { token, value, done } = (await request.json()) as {
    token: string;
    value: number;
    done?: boolean;
  };

  try {
    await resumeHook(token, { value, done });
    return new NextResponse("OK");
  } catch {
    return new NextResponse("Hook not found", { status: 404 });
  }
}
