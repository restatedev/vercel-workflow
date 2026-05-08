import { createHook } from "workflow";

export async function manualDisposalWorkflow(channelId: string) {
  "use workflow";

  const hook = createHook<{ message: string }>({
    token: `channel:${channelId}`,
  });

  const payload = await hook;
  console.log("Received:", payload.message);

  hook.dispose(); // Manually release the token
  console.log("Token released, continuing...");
}
