import {
  Run as CoreRun,
  start as coreStart,
  type StopSleepOptions,
  type StopSleepResult,
  type StartOptions,
} from "@workflow/core/runtime";
import * as clients from "@restatedev/restate-sdk-clients";
import { WorkflowRunCancelledError, WorkflowRunFailedError } from "@workflow/errors";
import { sleepObj, workflowRunObj } from "./runtime.js";
import { TerminalError } from "@restatedev/restate-sdk/fetch";

// Re-export everything from workflow/api that we don't override
export {
  resumeWebhook,
  runStep,
  type Event,
  type StartOptions,
  type StopSleepOptions,
  type StopSleepResult,
  type WorkflowReadableStreamOptions,
  type WorkflowRun,
} from "@workflow/core/runtime";
export { resumeHook, defineHook } from "./index.js";

function getIngressUrl(): string {
  const ingress = process.env["RESTATE_INGRESS"];
  if (!ingress) {
    throw new Error("Please set the RESTATE_INGRESS env var.");
  }
  return ingress.replace(/\/+$/, "");
}

/**
 * Restate-backed Run that overrides wakeUp() to resolve sleep awakeables
 * directly via the sleepObj virtual object instead of going through the
 * events API.
 */
export class Run<TResult> extends CoreRun<TResult> {
  override async wakeUp(
    options?: StopSleepOptions
  ): Promise<StopSleepResult> {
    const restate = clients.connect({ url: getIngressUrl() });
    const pending = await restate
      .objectClient(sleepObj, this.runId)
      .getPending();

    let targets = pending;
    if (options?.correlationIds?.length) {
      const ids = new Set(options.correlationIds);
      targets = pending.filter((e) => ids.has(e.correlationId));
    }

    let stoppedCount = 0;
    for (const entry of targets) {
      await restate
        .objectClient(sleepObj, this.runId)
        .wakeUp({ correlationId: entry.correlationId });
      stoppedCount++;
    }

    return { stoppedCount };
  }

  override get returnValue(): Promise<TResult> {
    return this.attachReturnValue();
  }

  private async attachReturnValue(): Promise<TResult> {
    const restate = clients.connect({ url: getIngressUrl() });
    try {
      return await restate
        .objectClient(workflowRunObj, this.runId)
        .awaitResult() as TResult;
    } catch (err) {
      if (err instanceof TerminalError && err.code === 409) {
        throw new WorkflowRunCancelledError(this.runId);
      }
     if (err instanceof TerminalError) {
        throw new WorkflowRunFailedError(this.runId, {
          message: err.message ?? "Unknown error",
        });
      }
      throw err;
    }
  }
}

export function getRun<TResult>(runId: string): Run<TResult> {
  return new Run<TResult>(runId);
}

// Wrap coreStart to return our Run subclass
type CoreStart = typeof coreStart;
export const start = (async (...args: Parameters<CoreStart>) => {
  const coreRun = await coreStart(...args);
  return new Run(coreRun.runId);
}) as CoreStart;
