import { getWritable } from "workflow";

type LogEntry = { level: string; message: string };
type MetricEntry = { cpu: number; memory: number };

async function writeLogs() {
  "use step";

  const logs = getWritable<LogEntry>({ namespace: "logs" });
  const writer = logs.getWriter();

  await writer.write({ level: "info", message: "Task started" });
  await writer.write({ level: "info", message: "Processing..." });

  writer.releaseLock();
}

async function writeMetrics() {
  "use step";

  const metrics = getWritable<MetricEntry>({ namespace: "metrics" });
  const writer = metrics.getWriter();

  await writer.write({ cpu: 45, memory: 512 });
  await writer.write({ cpu: 52, memory: 520 });

  writer.releaseLock();
}

async function closeStreams() {
  "use step";

  await getWritable({ namespace: "logs" }).close();
  await getWritable({ namespace: "metrics" }).close();
}

export async function multiStreamWorkflow() {
  "use workflow";

  await writeLogs();
  await writeMetrics();
  await closeStreams();
}
