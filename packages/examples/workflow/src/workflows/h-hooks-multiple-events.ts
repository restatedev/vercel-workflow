import { createHook } from "workflow";
import { triggerResume } from "./_callback.js";

export async function dataCollectionWorkflow() {
  "use workflow";
  using hook = createHook<{ value: number; done?: boolean }>();

  // Simulate an external data source POSTing three events to our resume
  // route, the last one signalling completion. Restate serializes the
  // resolve invocations per token, so these arrive in order.
  await triggerResume("h-resume", { token: hook.token, value: 1 });
  await triggerResume("h-resume", { token: hook.token, value: 2 });
  await triggerResume("h-resume", { token: hook.token, value: 3, done: true });

  const values: number[] = [];
  for await (const payload of hook) {
    values.push(payload.value);
    if (payload.done) {
      break;
    }
  }
  return { values };
}
