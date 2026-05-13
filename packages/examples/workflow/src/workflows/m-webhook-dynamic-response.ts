import { createWebhook, type RequestWithResponse } from "workflow";
import { registerCallback } from "./_callback.js";

async function sendCustomResponse(request: RequestWithResponse, message: string) {
  "use step";

  await request.respondWith(
    new Response(JSON.stringify({ message }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }),
  );
}

export async function webhookWithDynamicResponse() {
  "use workflow";

  // Set respondWith to "manual" to handle responses yourself
  using webhook = createWebhook({ respondWith: "manual" });

  await registerCallback(webhook.url, { type: "urgent" });

  const request = await webhook;
  const data = (await request.json()) as { type?: string };

  const responseMessage =
    data.type === "urgent" ? "Processing urgently" : "Processing normally";
  await sendCustomResponse(request, responseMessage);
  return { data, responseMessage };
}
