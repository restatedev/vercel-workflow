import { getRun, resumeHook, resumeWebhook, start } from "workflow/api";
import { hookWorkflow } from "../../../workflows/hooks.js";
import { calculateWorkflow } from "../../../workflows/simple.js";
import { multiSleepWorkflow, sleepingWorkflow } from "../../../workflows/sleeping.js";
import { webhookWorkflow } from "../../../workflows/webhook.js";
import { NextResponse } from "next/server.js";

export async function POST(_request: Request) {

    const run = await start(calculateWorkflow, [2, 7]);

    console.log("run:", run);
    console.log("run.runId:", run.runId);

    const result = await run.returnValue;

    console.log("result:", JSON.stringify(result), "expected:", JSON.stringify({ sum: 9, product: 14, combined: 23 }));

    const run2 = await start(sleepingWorkflow, ["test-input"]);

    // const sleepId = await waitForSleep(run2);
    await new Promise((resolve) => setTimeout(resolve, 2000));
    await getRun(run2.runId).wakeUp();

    const result2 = await run2.returnValue;
    console.log("result2:", JSON.stringify(result2), "expected:", JSON.stringify("finalized:prepared:test-input"));

    const run3 = await start(multiSleepWorkflow, ["multi"]);

    // Wake up the first sleep (1h)
    await new Promise((resolve) => setTimeout(resolve, 2000));
    // const firstSleepId = await waitForSleep(run3);
    await getRun(run3.runId).wakeUp();

    // Wake up the second sleep (24h)
    await new Promise((resolve) => setTimeout(resolve, 2000));
    // const secondSleepId = await waitForSleep(run3);
    await getRun(run3.runId).wakeUp();

    const result3 = await run3.returnValue;
    console.log("result3:", JSON.stringify(result3), "expected:", JSON.stringify("done:finalized:prepared:multi"));

    const run4 = await start(hookWorkflow, ["doc-1"]);

    // wait for one second
    await new Promise(resolve => setTimeout(resolve, 2000));

    await resumeHook("approval:doc-1", {
      approved: true,
      reviewer: "alice",
    });

    const result4 = await run4.returnValue;
    console.log("result4:", JSON.stringify(result4), "expected:", JSON.stringify({ status: "approved", reviewer: "alice" }));

    const run5 = await start(hookWorkflow, ["doc-2"]);

    // await waitForHook(run5, { token: "approval:doc-2" });
    await new Promise((resolve) => setTimeout(resolve, 2000));

    await resumeHook("approval:doc-2", {
      approved: false,
      reviewer: "bob",
    });

    const result5 = await run5.returnValue;
    console.log("result5:", JSON.stringify(result5), "expected:", JSON.stringify({ status: "rejected", reviewer: "bob" }));


    const run6 = await start(webhookWorkflow, ["endpoint-1"]);

    // Webhook tokens are randomly generated, so discover via waitForHook
    const result6 = await run6.returnValue;
  console.log(
    "result6:",
    JSON.stringify(result6),
    "expected:",
    JSON.stringify({
      endpointId: "endpoint-1",
      received: { event: "payment.completed", amount: 99 },
    })
  );

  return NextResponse.json({
    message: "Done",
  });
}