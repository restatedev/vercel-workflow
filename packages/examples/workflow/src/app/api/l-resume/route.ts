import { resumeHook } from "workflow/api";
import { NextResponse } from "next/server.js";

export async function POST(_request: Request) {
  const channelId = "channel123";
  try {
    await resumeHook(`channel:${channelId}`, { message: "hello" });
    return new NextResponse("OK");
  } catch {
    return new NextResponse("Hook not found", { status: 404 });
  }
}
