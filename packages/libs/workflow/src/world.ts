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

import * as serialization from "@workflow/core/serialization";
import { parseWorkflowName } from "./parse-name.js";
import type {
  World,
  WorkflowRun,
  EventResult,
  QueuePayload,
  ValidQueueName,
  MessageId,
} from "@workflow/world";

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

function getAdminUrl(): string {
  const admin = process.env["RESTATE_ADMIN_URL"];
  if (!admin) {
    throw new Error("Please set the RESTATE_ADMIN_URL env var.");
  }
  return admin.replace(/\/+$/, "");
}

// ---------------------------------------------------------------------------
// Durable metadata store — backed by the workflowRunMetadata virtual object
// in runtime.ts. Survives crashes.
// ---------------------------------------------------------------------------

interface StoredMetadata {
  workflowName: string;
  invocationId: string;
  createdAt: number;
}

async function storeMetadata(
  runId: string,
  workflowName: string,
  invocationId: string
): Promise<void> {
  const ingress = getIngressUrl();
  await fetch(
    `${ingress}/workflowRunMetadata/${encodeURIComponent(runId)}/store/send`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workflowName, invocationId }),
    }
  );
}

async function getMetadata(
  runId: string
): Promise<StoredMetadata | null> {
  const ingress = getIngressUrl();
  const res = await fetch(
    `${ingress}/workflowRunMetadata/${encodeURIComponent(runId)}/get`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "null",
    }
  );
  if (!res.ok) return null;
  return (await res.json()) as StoredMetadata | null;
}

// ---------------------------------------------------------------------------
// In-memory cache for serialized input (only needed between events.create
// and queue() within the same start() call — not durable)
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const inputCache = new Map<string, any[]>();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function workflowNameFromQueue(queueName: string): string {
  const prefix = "__wkf_workflow_";
  const workflowId = queueName.startsWith(prefix)
    ? queueName.slice(prefix.length)
    : queueName;

  return parseWorkflowName(workflowId)?.shortName ?? workflowId;
}

function makeRun(
  runId: string,
  workflowName: string,
  createdAt: Date,
  overrides: Partial<WorkflowRun>
): WorkflowRun {
  return {
    runId,
    deploymentId: "restate",
    workflowName,
    input: [],
    createdAt,
    updatedAt: new Date(),
    status: "running",
    output: undefined,
    error: undefined,
    completedAt: undefined,
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

  return {
    // ------ Queue ------

    getDeploymentId() {
      return Promise.resolve("restate");
    },

    async queue(
      queueName: ValidQueueName,
      message: QueuePayload,
      _opts?: { deploymentId?: string; idempotencyKey?: string }
    ) {
      const payload = message as { runId: string };
      const cachedInput = inputCache.get(payload.runId);
      if (!cachedInput) {
        throw new Error(
          `Cannot queue: serialized input for run ${payload.runId} not found`
        );
      }

      const serviceName = workflowNameFromQueue(queueName);

      // The input was serialized by Vercel's dehydrateWorkflowArguments (binary).
      // Deserialize it back to raw args so we can send JSON to Restate.
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      const rawArgs: unknown[] =
        await serialization.hydrateWorkflowArguments(
          cachedInput,
          payload.runId,
          undefined,
          globalThis
        );

      const res = await fetch(
        `${ingress}/${encodeURIComponent(serviceName)}/run/send`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(rawArgs[0]),
        }
      );

      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new Error(
          `Failed to start workflow "${serviceName}": ${res.status}${body ? ` - ${body}` : ""}`
        );
      }

      const data = (await res.json()) as { invocationId: string };

      // Store the mapping durably in the virtual object
      await storeMetadata(
        payload.runId,
        workflowNameFromQueue(queueName),
        data.invocationId
      );

      // Clean up the transient input cache
      inputCache.delete(payload.runId);

      return { messageId: data.invocationId as MessageId };
    },

    createQueueHandler() {
      // Restate handles workflow execution directly — no queue handler needed.
      // Return a no-op HTTP handler so withWorkflow() doesn't crash.
      return () => Promise.resolve(new Response(null, { status: 404 }));
    },

    // ------ Storage: runs ------

    runs: {
      async get(id: string): Promise<WorkflowRun> {
        const meta = await getMetadata(id);
        if (!meta) {
          // Return a minimal run for hook resolution (runId="restate" placeholder)
          return {
            runId: id,
            deploymentId: "restate",
            workflowName: "unknown",
            input: [],
            createdAt: new Date(),
            updatedAt: new Date(),
            status: "running",
            output: undefined,
            error: undefined,
            completedAt: undefined,
          } as WorkflowRun;
        }

        const res = await fetch(
          `${ingress}/restate/invocation/${encodeURIComponent(meta.invocationId)}/output`,
          { headers: { Accept: "application/json" } }
        );

        const createdAt = new Date(meta.createdAt);

        if (res.ok) {
          const output: unknown = await res.json();
          return makeRun(id, meta.workflowName, createdAt, {
            status: "completed",
            output,
            completedAt: new Date(),
          });
        }

        if (res.status === 470) {
          return makeRun(id, meta.workflowName, createdAt, {
            status: "running",
          });
        }

        const errorText = await res.text().catch(() => "");
        return makeRun(id, meta.workflowName, createdAt, {
          status: "failed",
          error: { message: errorText || "Workflow failed" },
          completedAt: new Date(),
        });
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

          // Cache the serialized input for queue() to pick up
          inputCache.set(runId!, eventData.input);

          const now = new Date();
          return {
            run: makeRun(
              runId!,
              eventData.workflowName,
              now,
              { status: "pending" }
            ),
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
          await fetch(
            `${ingress}/workflowHooks/${encodeURIComponent(token)}/resolve`,
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(rawPayload),
            }
          );
          return {};
        }

        if (eventType === "run_cancelled" && runId) {
          const meta = await getMetadata(runId);
          if (meta?.invocationId) {
            const admin = getAdminUrl();
            await fetch(
              `${admin}/invocations/${encodeURIComponent(meta.invocationId)}`,
              { method: "DELETE" }
            );
          }
          if (meta) {
            return {
              run: makeRun(
                runId,
                meta.workflowName,
                new Date(meta.createdAt),
                { status: "cancelled", completedAt: new Date() }
              ),
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
      get: notImplemented("hooks.get"),
      getByToken(token: string) {
        // Return a minimal Hook object. Vercel's resumeHook uses this to
        // get the runId and hookId before creating a hook_received event.
        // We use the token as hookId and a placeholder runId — the actual
        // resumption is done in events.create for hook_received.
        return Promise.resolve({
          runId: "restate",
          hookId: token,
          token,
          ownerId: "restate",
          projectId: "restate",
          environment: "development",
          createdAt: new Date(),
        });
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
