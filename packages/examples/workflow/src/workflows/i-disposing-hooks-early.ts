import { createHook } from "workflow";
export async function handoffWorkflow(channelId: string) {
  "use workflow";
  {
    using hook = createHook<{ message: string; handoff?: boolean }>({
      token: `channel:${channelId}`,
    });
    for await (const payload of hook) {
      console.log("Received:", payload.message);
      if (payload.handoff) {
        break;
      }
    }
  } // Hook token released here
  // Token is now available for another workflow
  console.log("Continuing with other work...");
}
