import { resumeWebhook } from "workflow/api";
import { NextResponse } from "next/server.js";

export async function POST(request: Request) {
  const { token } = (await request.json()) as { token: string };

  await resumeWebhook(
    token,
    new Request("https://example.com/webhook", {
      method: "POST",
      body: JSON.stringify({ event: "payment.completed", amount: 99 }),
      headers: { "Content-Type": "application/json" },
    })
  );

  return NextResponse.json({
    message: "OK",
  });
}
