import { getWritable, sleep } from "workflow";

async function emit(value: number) {
  "use step";

  const writable = getWritable<string>();
  const writer = writable.getWriter();
  await writer.write(`chunk-${value}\n`);
  writer.releaseLock();
}

export async function resumableStreamWorkflow() {
  "use workflow";

  for (let i = 0; i < 20; i++) {
    await emit(i);
    await sleep("500ms");
  }
}
