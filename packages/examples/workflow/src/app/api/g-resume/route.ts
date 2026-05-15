import { resumeHook } from "workflow/api";
import { NextResponse } from "next/server.js";
export async function POST(_request: Request) {
  const channelId = "channel123";
  try {
    // Reconstruct the token using the channel ID
    await resumeHook(`slack_messages:${channelId}`, {
      user: "Pete",
      text: "hello",
    });
    await resumeHook(`slack_messages:${channelId}`, {
      user: "Pete",
      text: "hello again",
    });
    await resumeHook(`slack_messages:${channelId}`, {
      user: "Pete",
      text: "/stop",
    });
    return new NextResponse("OK");
  } catch (error) {
    return new NextResponse("Hook not found");
  }
}
