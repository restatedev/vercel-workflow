/* eslint-disable @typescript-eslint/require-await */
import { createWebhook, type RequestWithResponse } from "workflow";

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
  console.log("Send events to:", webhook.url);

  for await (const request of webhook) {
    const data = (await request.json()) as { type?: string };

    if (data.type === "done") {
      await sendAck(request, "Workflow complete");
      break;
    }

    await sendAck(request, "Event received");
    await processEvent(data);
  }
}
