import {
  Run as CoreRun,
  start as coreStart,
  type StopSleepOptions,
  type StopSleepResult,
} from "@workflow/core/runtime";
import type { WorkflowRunStatus } from "@workflow/world";
import * as clients from "@restatedev/restate-sdk-clients";
import {
  WorkflowRunCancelledError,
  WorkflowRunFailedError,
} from "@workflow/errors";
import { hookObj, sleepObj, workflowRunObj } from "./runtime.js";
import { TerminalError } from "@restatedev/restate-sdk/fetch";
import type { HookMetadata } from "./index.js";

// Re-export everything from workflow/api that we don't override
export {
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
  override async wakeUp(options?: StopSleepOptions): Promise<StopSleepResult> {
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

  override get status(): Promise<WorkflowRunStatus> {
    return this.fetchStatus();
  }

  private async fetchStatus(): Promise<WorkflowRunStatus> {
    const restate = clients.connect({ url: getIngressUrl() });
    const data = await restate.objectClient(workflowRunObj, this.runId).get();
    if (!data) {
      throw new Error(`Workflow run ${this.runId} not found`);
    }
    return data.status;
  }

  override get exists(): Promise<boolean> {
    return this.checkExists();
  }

  private async checkExists(): Promise<boolean> {
    const restate = clients.connect({ url: getIngressUrl() });
    const data = await restate.objectClient(workflowRunObj, this.runId).get();
    return data !== null;
  }

  override get returnValue(): Promise<TResult> {
    return this.attachReturnValue();
  }

  private async attachReturnValue(): Promise<TResult> {
    const restate = clients.connect({ url: getIngressUrl() });
    try {
      return (await restate
        .objectClient(workflowRunObj, this.runId)
        .awaitResult()) as TResult;
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

/**
 * Resumes a webhook hook by serializing the incoming HTTP Request and
 * resolving the corresponding awakeable in Restate.
 *
 * Only hooks created via `createWebhook()` (i.e. with `isWebhook: true`)
 * can be resumed through this function. Regular hooks must use `resumeHook()`.
 *
 * @param token - The webhook token (discovered via hook.token inside the workflow)
 * @param request - The incoming HTTP Request to forward to the workflow
 * @returns The HTTP Response to send back to the caller
 */
export async function resumeWebhook(
  token: string,
  request: Request
): Promise<HookMetadata> {
  const ingress = getIngressUrl();
  const restate = clients.connect({ url: ingress });

  // Look up the hook to verify it exists and is a webhook
  const hookData = await restate.objectClient(hookObj, token).get();
  if (!hookData) {
    throw new Error(`Webhook hook not found (token=${token})`);
  }
  if (!hookData.isWebhook) {
    // Same behavior as Vercel: don't reveal that the token exists
    throw new Error(`Webhook hook not found (token=${token})`);
  }

  // Serialize the Request to a JSON-compatible format
  const body = await request.text();
  const serialized = {
    method: request.method,
    url: request.url,
    headers: [...request.headers.entries()],
    body: body || null,
  };

  // Resolve the hook's awakeable with the serialized Request
  const url = `${ingress}/workflowHooks/${encodeURIComponent(token)}/resolve`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(serialized),
  });

  if (!res.ok) {
    const resBody = await res.text().catch(() => "");
    throw new Error(
      `Failed to resume webhook (token=${token}): ${res.status} ${res.statusText}${resBody ? ` - ${resBody}` : ""}`
    );
  }

  return (await res.json()) as HookMetadata;
}
