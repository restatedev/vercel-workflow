import { start } from "workflow/api";
import { simpleStreamingWorkflow } from "../../../workflows/p-streaming-basic.js";

export async function POST() {
  const run = await start(simpleStreamingWorkflow);

  return new Response(run.readable, {
    headers: { "Content-Type": "text/plain" },
  });
}
