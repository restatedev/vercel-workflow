/**
 * Test/example utility endpoint that plays the role of an external service.
 *
 * A workflow that wants to be driven end-to-end without manual curling
 * POSTs here with the callback URL it wants invoked, the payload, and an
 * optional delay. We schedule the POST and return immediately. This is the
 * same shape a real external API integration would have — the workflow
 * hands over its callback URL, the external service eventually calls back.
 */
import { NextResponse } from "next/server.js";

interface CallbackRequest {
  callbackUrl: string;
  payload: unknown;
  delayMs?: number;
  method?: string;
}

export async function POST(request: Request) {
  const { callbackUrl, payload, delayMs = 200, method = "POST" } =
    (await request.json()) as CallbackRequest;

  console.log(`[_callback] POSTing to ${callbackUrl} with payload:`, payload);

  setTimeout(() => {
    void fetch(callbackUrl, {
      method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    }).catch((err) => {
      console.error(`[_callback] POST to ${callbackUrl} failed:`, err);
    });
  }, delayMs);

  return NextResponse.json({ scheduled: true });
}
