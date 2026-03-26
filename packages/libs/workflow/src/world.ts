/*
 * Copyright (c) TODO: Add copyright holder
 *
 * This file is part of TODO: Add project name,
 * which is released under the MIT license.
 *
 * You can find a copy of the license in file LICENSE in the root
 * directory of this repository or package, or at
 * TODO: Add repository URL
 */

import * as clients from "@restatedev/restate-sdk-clients";
import * as serialization from "@workflow/core/serialization";
import { parseWorkflowName } from "./parse-name.js";
import { workflowRunObj, hookObj } from "./runtime.js";
import type { WorkflowRunData } from "./runtime.js";
import type {
  World,
  WorkflowRun,
  EventResult,
  QueuePayload,
  ValidQueueName,
  MessageId,
  QueueOptions,
} from "@workflow/world";
import { WorkflowRunNotFoundError } from "@workflow/errors";

// ---------------------------------------------------------------------------
// Env helpers
// ---------------------------------------------------------------------------

function getIngressUrl(): string {
  const ingress = process.env["RESTATE_INGRESS"];
  if (!ingress) {
    throw new Error("Please set the RESTATE_INGRESS env var.");
  }
  return ingress.replace(/\/+$/, "");
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function toWorkflowRun(data: WorkflowRunData): Promise<WorkflowRun> {
  const overrides: Partial<WorkflowRun> = {};

  if (data.status === "completed" && data.output !== undefined) {
    overrides.output = await serialization.dehydrateWorkflowReturnValue(
      data.output,
      data.runId,
      undefined,
      globalThis
    );
  }

  if (data.error) {
    overrides.error = { message: data.error };
  }

  return {
    runId: data.runId,
    deploymentId: "restate",
    workflowName: data.workflowName,
    input: [],
    createdAt: new Date(data.createdAt),
    updatedAt: new Date(),
    status: data.status,
    output: undefined,
    error: undefined,
    completedAt: data.completedAt ? new Date(data.completedAt) : undefined,
    ...overrides,
  } as WorkflowRun;
}

function notImplemented(name: string): (...args: unknown[]) => never {
  return () => {
    throw new Error(`[restate-world] ${name} is not implemented`);
  };
}

// ---------------------------------------------------------------------------
// createWorld — the Restate-backed World implementation
// ---------------------------------------------------------------------------

export function createWorld(): World {
  const ingress = getIngressUrl();
  const restate = clients.connect({ url: ingress });

  return {
    // ------ Queue ------

    getDeploymentId() {
      return Promise.resolve("restate");
    },

    async queue(
      _queueName: ValidQueueName,
      message: QueuePayload,
      opts?: QueueOptions
    ) {
      const payload = message as { runId: string };

      // Submit the workflow run (fire-and-forget — submit awaits completion internally)
      await restate
        .objectSendClient(workflowRunObj, payload.runId)
        .submit({
          idempotencyKey: opts?.idempotencyKey,
          delaySeconds: opts?.delaySeconds,
        });

      return { messageId: payload.runId as MessageId };
    },

    createQueueHandler() {
      // Restate handles workflow execution directly — no queue handler needed.
      // Return a no-op HTTP handler so withWorkflow() doesn't crash.
      return () => Promise.resolve(new Response(null, { status: 404 }));
    },

    // ------ Storage: runs ------

    runs: {
      async get(id: string): Promise<WorkflowRun> {
        const data: WorkflowRunData | null = await restate
          .objectClient(workflowRunObj, id)
          .get();

        if (!data) {
          throw new WorkflowRunNotFoundError(id);
        }

        return toWorkflowRun(data);
      },

      list: notImplemented("runs.list") as unknown as World["runs"]["list"],
    } as World["runs"],

    // ------ Storage: events ------

    events: {
      async create(
        runId: string | null,
        data: unknown,
        _params?: unknown
      ): Promise<EventResult> {
        const eventType = (data as { eventType: string }).eventType;

        if (eventType === "run_created") {
          const eventData = (
            data as {
              eventData: {
                workflowName: string;
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                input: any[];
              };
            }
          ).eventData;

          const serviceName = parseWorkflowName(eventData.workflowName)?.shortName ?? eventData.workflowName;

          // Deserialize input from Vercel's binary format to raw JSON
          // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
          const rawArgs: unknown[] =
            await serialization.hydrateWorkflowArguments(
              eventData.input,
              runId!,
              undefined,
              globalThis
            );

          // Create the workflow run object — stores input durably in Restate
          const runData = await restate
            .objectClient(workflowRunObj, runId!)
            .create({
              workflowName: eventData.workflowName,
              serviceName,
              input: JSON.stringify(rawArgs),
            });

          return {
            run: await toWorkflowRun(runData),
          };
        }

        if (eventType === "hook_received" && runId) {
          const eventData = (
            data as {
              correlationId: string;
              eventData: { payload: unknown };
            }
          );
          // The payload was serialized by Vercel's dehydrateStepReturnValue.
          // Deserialize it back to the raw value before sending to Restate.
          // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
          const rawPayload = await serialization.hydrateStepArguments(
            eventData.eventData.payload,
            runId,
            undefined
          );
          // Forward to Restate's workflowHooks virtual object
          const token = eventData.correlationId;
          await restate
            .objectClient(hookObj, token)
            .resolve(rawPayload);
          return {};
        }

        if (eventType === "run_cancelled" && runId) {
          const cancelData: WorkflowRunData | null = await restate
            .objectClient(workflowRunObj, runId)
            .cancel();

          if (cancelData) {
            return {
              run: await toWorkflowRun(cancelData),
            };
          }
        }

        return {};
      },

      get: notImplemented("events.get") as unknown as World["events"]["get"],
      list: notImplemented(
        "events.list"
      ) as unknown as World["events"]["list"],
      listByCorrelationId: notImplemented(
        "events.listByCorrelationId"
      ) as unknown as World["events"]["listByCorrelationId"],
    } as World["events"],

    // ------ Storage: steps (stub) ------

    steps: {
      get: notImplemented("steps.get"),
      list: notImplemented("steps.list"),
    } as unknown as World["steps"],

    // ------ Storage: hooks ------

    hooks: {
      async get(hookId: string) {
        const hookData = await restate
          .objectClient(hookObj, hookId)
          .get();
        if (!hookData) {
          throw new Error(`Hook ${hookId} not found`);
        }
        return { ...hookData, createdAt: new Date(hookData.createdAt) };
      },
      async getByToken(token: string) {
        const hookData = await restate
          .objectClient(hookObj, token)
          .get();
        if (!hookData) {
          throw new Error(`Hook with token ${token} not found`);
        }
        return { ...hookData, createdAt: new Date(hookData.createdAt) };
      },
      list: notImplemented("hooks.list"),
    } as unknown as World["hooks"],

    // ------ Streamer (stub) ------

    writeToStream: notImplemented(
      "writeToStream"
    ) as unknown as World["writeToStream"],
    closeStream: notImplemented(
      "closeStream"
    ) as unknown as World["closeStream"],
    readFromStream: notImplemented(
      "readFromStream"
    ) as unknown as World["readFromStream"],
    listStreamsByRunId: notImplemented(
      "listStreamsByRunId"
    ) as unknown as World["listStreamsByRunId"],
  };
}
