import { createUIMessageStreamResponse } from "ai";
import { start } from "workflow/api";
import { aiAssistantWorkflow } from "../../../workflows/x-streaming-ai.js";

export async function POST(request: Request) {
  const { message } = (await request.json().catch(() => ({}))) as {
    message?: string;
  };

  const run = await start(aiAssistantWorkflow, [
    message ?? "Find me a flight to Paris",
  ]);

  return createUIMessageStreamResponse({
    stream: run.readable,
  });
}
