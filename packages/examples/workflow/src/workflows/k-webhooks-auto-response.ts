/* eslint-disable @typescript-eslint/require-await */
import { createWebhook } from "workflow";
import { registerCallback } from "./_callback.js";

export async function webhookWithStaticResponse() {
  "use workflow";
  using webhook = createWebhook({
    respondWith: Response.json({
      success: true,
      message: "Webhook received",
    }),
  });

  await registerCallback(webhook.url, { hello: "world" });

  const request = await webhook;
  // The response was already sent automatically
  const data = (await request.json()) as Record<string, unknown>;
  await processData(data);
  return { data };
}
async function processData(_data: unknown) {
  "use step";
  // Long-running processing here
}
