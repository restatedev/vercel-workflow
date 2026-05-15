import { createWebhook, type RequestWithResponse } from "workflow";
import { registerCallback } from "./_callback.js";

async function sendAck(request: RequestWithResponse, message: string) {
  "use step";

  await request.respondWith(Response.json({ received: true, message }));
}

async function processEvent(data: unknown) {
  "use step";
  console.log("Processing event:", data);
}

export async function eventCollectorWorkflow() {
  "use workflow";

  using webhook = createWebhook({ respondWith: "manual" });

  // Simulate an external event source streaming three events, the last
  // one ending the loop.
  await registerCallback(webhook.url, { type: "event", id: 1 }, 100);
  await registerCallback(webhook.url, { type: "event", id: 2 }, 200);
  await registerCallback(webhook.url, { type: "done" }, 300);

  const events: unknown[] = [];
  let stoppedOn: string | undefined;
  for await (const request of webhook) {
    const data = (await request.json()) as { type?: string };

    if (data.type === "done") {
      await sendAck(request, "Workflow complete");
      stoppedOn = "done";
      break;
    }

    await sendAck(request, "Event received");
    await processEvent(data);
    events.push(data);
  }
  return { events, stoppedOn };
}
