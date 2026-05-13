import { createHook } from "workflow";
import { triggerResume } from "./_callback.js";

export async function handoffWorkflow(channelId: string) {
  "use workflow";

  const received: { message: string; handoff?: boolean }[] = [];
  {
    using hook = createHook<{ message: string; handoff?: boolean }>({
      token: `channel:${channelId}`,
    });
    // Simulate an external chat system POSTing two messages: a regular one,
    // then a handoff signal that releases the hook scope.
    await triggerResume("i-resume", { channelId, message: "hello" });
    await triggerResume("i-resume", {
      channelId,
      message: "bye",
      handoff: true,
    });
    for await (const payload of hook) {
      received.push(payload);
      if (payload.handoff) {
        break;
      }
    }
  } // Hook token released here
  return { channelId, received };
}
