import { start } from "workflow/api";
import { batchProcessingWorkflow } from "../../../workflows/t-streaming-progress.js";

export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as {
    items?: string[];
  };
  const items = body.items ?? ["item-a", "item-b", "item-c"];

  const run = await start(batchProcessingWorkflow, [items]);

  return new Response(run.readable, {
    headers: { "Content-Type": "application/json" },
  });
}
