import { DurableAgent } from "@workflow/ai/agent";
import { getWritable } from "workflow";
import { z } from "zod";
import type { UIMessageChunk } from "ai";

async function searchFlights({ query }: { query: string }) {
  "use step";

  const writable = getWritable<UIMessageChunk>();
  const writer = writable.getWriter();
  await writer.write({
    type: "data-progress",
    data: { message: `Searching flights for ${query}...` },
    transient: true,
  });
  writer.releaseLock();

  return { flights: [/* results */] };
}

export async function aiAssistantWorkflow(userMessage: string) {
  "use workflow";

  const agent = new DurableAgent({
    model: "anthropic/claude-haiku-4.5",
    system: "You are a helpful flight assistant.",
    tools: {
      searchFlights: {
        description: "Search for flights",
        inputSchema: z.object({ query: z.string() }),
        execute: searchFlights,
      },
    },
  });

  await agent.stream({
    messages: [{ role: "user", content: userMessage }],
    writable: getWritable<UIMessageChunk>(),
  });
}
