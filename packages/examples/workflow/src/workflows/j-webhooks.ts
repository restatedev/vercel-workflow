import { createWebhook } from "workflow";
import { registerCallback } from "./_callback.js";

export async function webhookWorkflow() {
  "use workflow";
  using webhook = createWebhook();

  // Hand our webhook URL to a (simulated) external service that will POST
  // back. In a real workflow this is registering with Slack, Stripe, etc.
  await registerCallback(webhook.url, { hello: "world" });

  const request = await webhook;
  const data = (await request.json()) as Record<string, unknown>;
  return { method: request.method, data };
}
