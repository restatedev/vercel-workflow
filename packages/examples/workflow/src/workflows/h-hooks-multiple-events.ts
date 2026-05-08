import { createHook } from "workflow";
export async function dataCollectionWorkflow() {
  "use workflow";
  using hook = createHook<{ value: number; done?: boolean }>();
  const values: number[] = [];
  // Keep receiving data until we get a "done" signal
  for await (const payload of hook) {
    values.push(payload.value);
    if (payload.done) {
      break;
    }
  }
  console.log("Collected values:", values);
  return values;
}
