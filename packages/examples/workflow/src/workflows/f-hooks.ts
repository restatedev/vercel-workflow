import { createHook } from "workflow";
import { triggerResume } from "./_callback.js";

export async function approvalWorkflow() {
  "use workflow";
  using hook = createHook<{ approved: boolean; comment: string }>();

  // Simulate an external approver POSTing the verdict to our resume route.
  await triggerResume("f-resume", {
    token: hook.token,
    approved: true,
    comment: "lgtm",
  });

  const result = await hook;
  return result;
}
