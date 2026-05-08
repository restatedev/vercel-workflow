import { createWebhook } from "workflow";
export async function webhookWorkflow() {
  "use workflow";
  using webhook = createWebhook();
  // The webhook is automatically available at this URL
  console.log("Send HTTP requests to:", webhook.url);
  // Example: https://your-app.com/.well-known/workflow/v1/webhook/lJHkuMdQ2FxSFTbUMU84k
  // Workflow pauses until an HTTP request is received
  const request = await webhook;
  console.log("Received request:", request.method, request.url);
  const data = await request.json();
  console.log("Data:", data);
}
