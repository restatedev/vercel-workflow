/* eslint-disable @typescript-eslint/require-await */
import { sleep } from "workflow";

async function prepareData(input: string) {
  "use step";
  return `prepared:${input}`;
}

async function finalizeData(data: string) {
  "use step";
  return `finalized:${data}`;
}

export async function sleepWorkflow(input: string) {
  "use workflow";

  const prepared = await prepareData(input);
  await sleep("1s");
  const intermediate = await finalizeData(prepared);
  await sleep("2s");

  return `done:${intermediate}`;
}
