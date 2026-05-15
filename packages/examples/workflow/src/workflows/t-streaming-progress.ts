import { getWritable, sleep } from "workflow";

type ProgressUpdate = {
  item: string;
  progress: number;
  status: string;
};

async function processItem(item: string, current: number, total: number) {
  "use step";

  const writable = getWritable<ProgressUpdate>();
  const writer = writable.getWriter();

  await new Promise((resolve) => setTimeout(resolve, 1000));

  await writer.write({
    item,
    progress: Math.round((current / total) * 100),
    status: "processing",
  });

  writer.releaseLock();
}

async function finalizeProgress() {
  "use step";

  await getWritable().close();
}

export async function batchProcessingWorkflow(items: string[]) {
  "use workflow";

  for (let i = 0; i < items.length; i++) {
    await processItem(items[i], i + 1, items.length);
    await sleep("1s");
  }

  await finalizeProgress();
}
