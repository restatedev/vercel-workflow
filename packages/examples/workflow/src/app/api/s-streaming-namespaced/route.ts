import { start } from "workflow/api";
import { multiStreamWorkflow } from "../../../workflows/s-streaming-namespaced.js";

type LogEntry = { level: string; message: string };

export async function POST() {
  const run = await start(multiStreamWorkflow);

  // Pick the "logs" namespace; switch to "metrics" to read the other channel.
  const logs = run.getReadable<LogEntry>({ namespace: "logs" });

  return new Response(logs, {
    headers: { "Content-Type": "application/json" },
  });
}
