import { getWritable } from "workflow";

async function writeProgress(message: string) {
  "use step";

  const writable = getWritable<string>();
  const writer = writable.getWriter();
  await writer.write(message);
  writer.releaseLock();
}

export async function simpleStreamingWorkflow() {
  "use workflow";

  await writeProgress("Starting task...");
  await writeProgress("Processing data...");
  await writeProgress("Task complete!");
}
