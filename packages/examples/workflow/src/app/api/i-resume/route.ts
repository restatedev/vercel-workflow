import { resumeHook } from "workflow/api";
import { NextResponse } from "next/server.js";

export async function POST(request: Request) {
  const { channelId, message, handoff } = (await request.json()) as {
    channelId?: string;
    message: string;
    handoff?: boolean;
  };
  const id = channelId ?? "channel123";

  try {
    await resumeHook(`channel:${id}`, { message, handoff });
    return new NextResponse("OK");
  } catch {
    return new NextResponse("Hook not found", { status: 404 });
  }
}
