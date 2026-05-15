import { WorkflowRunFailedError } from "@workflow/errors";
import { start } from "workflow/api";
import { callApiWorkflow } from "../../../workflows/d-retryable-error.js";
import { NextResponse } from "next/server.js";

export async function POST(_request: Request) {
  const run = await start(callApiWorkflow, ["https://httpbin.io/status/500"]);
  try {
    const result = await run.returnValue;
    return NextResponse.json({ result });
  } catch (err) {
    if (WorkflowRunFailedError.is(err)) {
      console.log(err.cause.code); // "USER_ERROR", "RUNTIME_ERROR", or undefined
      // `cause` is the original thrown value, hydrated through the workflow
      // serialization pipeline. It can be any thrown value, so check shape.
      if (err.cause instanceof Error) {
        console.log(err.cause.message); // The error message
      }
    }
  }
}
