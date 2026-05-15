import { start } from "workflow/api";
import { idempotentChargeWorkflow } from "../../../workflows/y-idempotency.js";
import { NextResponse } from "next/server.js";

export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as {
    userId?: string;
    amount?: number;
  };
  const userId = body.userId ?? "user_123";
  const amount = body.amount ?? 1000;

  const run = await start(idempotentChargeWorkflow, [userId, amount]);
  const charge = await run.returnValue;

  return NextResponse.json({ runId: run.runId, charge });
}
