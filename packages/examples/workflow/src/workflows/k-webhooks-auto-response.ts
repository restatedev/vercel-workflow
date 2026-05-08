/* eslint-disable @typescript-eslint/require-await */
import { createWebhook } from "workflow";
export async function webhookWithStaticResponse() {
  "use workflow";
  using webhook = createWebhook({
    respondWith: Response.json({
      success: true,
      message: "Webhook received",
    }),
  });
  const request = await webhook;
  // The response was already sent automatically
  const data = await request.json();
  await processData(data);
}
async function processData(_data: any) {
  "use step";
  // Long-running processing here
}
