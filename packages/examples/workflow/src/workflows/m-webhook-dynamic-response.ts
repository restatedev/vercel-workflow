import { createWebhook, type RequestWithResponse } from "workflow";

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
  console.log("Send HTTP requests to:", webhook.url);

  const request = await webhook;
  const data = (await request.json()) as { type?: string };

  if (data.type === "urgent") {
    await sendCustomResponse(request, "Processing urgently");
  } else {
    await sendCustomResponse(request, "Processing normally");
  }
}
