import { createHook } from "workflow";
import { triggerResume } from "./_callback.js";

export async function manualDisposalWorkflow(channelId: string) {
  "use workflow";

  const hook = createHook<{ message: string }>({
    token: `channel:${channelId}`,
  });

  // Simulate the external system that resumes the hook.
  await triggerResume("l-resume", {});

  const payload = await hook;

  hook.dispose(); // Manually release the token
  return { channelId, payload };
}
