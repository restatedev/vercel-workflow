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

function getAdminUrl(): string {
  const admin = process.env["RESTATE_ADMIN_URL"];
  if (!admin) {
    throw new Error("Please set the RESTATE_ADMIN_URL env var.");
  }
  return admin.replace(/\/+$/, "");
}

async function restateQuery<T>(sql: string): Promise<T[]> {
  const res = await fetch(`${getAdminUrl()}/query`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({ query: sql }),
  });
  if (!res.ok) {
    throw new Error(
      `Restate admin query failed (${res.status}): ${await res.text()}`
    );
  }
  const body = (await res.json()) as { rows?: T[] };
  return body.rows ?? [];
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
    // Errors thrown from a workflow handler are user-code errors by
    // definition (per upstream's `RUN_ERROR_CODES.USER_ERROR`: "Error
    // thrown in user workflow or step code"). Set USER_ERROR so consumers
    // checking `error.cause.code` after `run.returnValue.catch(...)` get
    // the expected code via both code paths:
    //   1. our overridden `attachReturnValue` (when start() comes from
    //      `workflow/api`, which sets prototype via setPrototypeOf), and
    //   2. upstream's `#pollReturnValue` (when start() comes directly from
    //      `@workflow/core/runtime`, e.g. in the e2e suite).
    overrides.error = { message: data.error, code: "USER_ERROR" };
  }

  const rawArgs = JSON.parse(data.serializedInput) as unknown[];
  const input = (await serialization.dehydrateWorkflowArguments(
    rawArgs,
    data.runId,
    undefined,
    [],
    globalThis
  )) as unknown[];

  return {
    runId: data.runId,
    deploymentId: "restate",
    workflowName: data.workflowName,
    input,
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

// upstream's getHookByTokenWithKey runs hydrateStepArguments(hook.metadata)
// on whatever we return, so the value must be in dehydrate's wire form.
async function toHook(hookData: {
  runId: string;
  hookId: string;
  token: string;
  ownerId: string;
  projectId: string;
  environment: string;
  createdAt: number;
  isWebhook: boolean;
  metadata: unknown;
}) {
  const metadata =
    hookData.metadata === undefined || hookData.metadata === null
      ? undefined
      : await serialization.dehydrateStepArguments(
          hookData.metadata,
          hookData.runId,
          undefined,
          globalThis
        );
  return {
    ...hookData,
    createdAt: new Date(hookData.createdAt),
    isWebhook: hookData.isWebhook ?? false,
    metadata,
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

      async list(params: {
        workflowName?: string;
        status?: WorkflowRunData["status"];
        pagination?: {
          limit?: number;
          cursor?: string;
          sortOrder?: "asc" | "desc";
        };
      } = {}) {
        const rows = await restateQuery<{
          service_key: string;
          value_utf8: string;
        }>(
          `SELECT service_key, value_utf8 FROM state
             WHERE service_name = 'workflowRun' AND key = 'data'`
        );

        let runs: WorkflowRunData[] = [];
        for (const row of rows) {
          try {
            runs.push(JSON.parse(row.value_utf8) as WorkflowRunData);
          } catch {
            /* skip malformed rows */
          }
        }
        if (params.workflowName) {
          runs = runs.filter((r) => r.workflowName === params.workflowName);
        }
        if (params.status) {
          runs = runs.filter((r) => r.status === params.status);
        }

        const sortOrder = params.pagination?.sortOrder ?? "desc";
        runs.sort((a, b) =>
          sortOrder === "asc"
            ? a.createdAt - b.createdAt
            : b.createdAt - a.createdAt
        );

        const limit = params.pagination?.limit ?? 100;
        const offset = params.pagination?.cursor
          ? parseInt(params.pagination.cursor, 10)
          : 0;
        const page = runs.slice(offset, offset + limit);
        const data = await Promise.all(page.map(toWorkflowRun));
        const hasMore = offset + limit < runs.length;

        return {
          data,
          cursor: hasMore ? String(offset + limit) : null,
          hasMore,
        };
      },
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
          let rawPayload = await serialization.hydrateStepArguments(
            eventData.eventData.payload,
            runId,
            undefined
          );

          // Request objects (from webhooks) are not JSON-serializable —
          // their properties are non-enumerable so JSON.stringify produces "{}".
          // Re-serialize to a plain object that the Restate client can transport.
          if (rawPayload instanceof Request) {
            rawPayload = {
              method: rawPayload.method,
              url: rawPayload.url,
              headers: [...rawPayload.headers.entries()],
              body: (await rawPayload.text()) || null,
            };
          }

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
        const hookData = await restate.objectClient(hookObj, hookId).get();
        if (!hookData) {
          throw new Error(`Hook ${hookId} not found`);
        }
        return toHook(hookData);
      },
      async getByToken(token: string) {
        const hookData = await restate.objectClient(hookObj, token).get();
        if (!hookData) {
          throw new Error(`Hook with token ${token} not found`);
        }
        return toHook(hookData);
      },
      async list(params: {
        runId?: string;
        pagination?: {
          limit?: number;
          cursor?: string;
          sortOrder?: "asc" | "desc";
        };
      } = {}) {
        const rows = await restateQuery<{
          service_key: string;
          key: string;
          value_utf8: string;
        }>(
          "SELECT service_key, key, value_utf8 FROM state WHERE service_name = 'workflowHooks'"
        );

        // Group state rows back into one record per token.
        const byToken = new Map<string, Record<string, unknown>>();
        for (const row of rows) {
          let value: unknown;
          try {
            value = JSON.parse(row.value_utf8);
          } catch {
            continue;
          }
          const entry = byToken.get(row.service_key) ?? {};
          entry[row.key] = value;
          byToken.set(row.service_key, entry);
        }

        const hooks: {
          runId: string;
          hookId: string;
          token: string;
          ownerId: string;
          projectId: string;
          environment: string;
          createdAt: number;
          isWebhook: boolean;
          metadata: unknown;
        }[] = [];
        for (const [token, state] of byToken) {
          if (typeof state.runId !== "string") continue;
          if (params.runId && state.runId !== params.runId) continue;
          hooks.push({
            runId: state.runId,
            hookId: token,
            token,
            ownerId: "restate",
            projectId: "restate",
            environment: "development",
            createdAt: (state.createdAt as number) ?? 0,
            isWebhook: (state.isWebhook as boolean) ?? false,
            metadata: state.metadata,
          });
        }

        const sortOrder = params.pagination?.sortOrder ?? "desc";
        hooks.sort((a, b) =>
          sortOrder === "asc"
            ? a.createdAt - b.createdAt
            : b.createdAt - a.createdAt
        );

        const limit = params.pagination?.limit ?? 100;
        const offset = params.pagination?.cursor
          ? parseInt(params.pagination.cursor, 10)
          : 0;
        const page = hooks.slice(offset, offset + limit);
        const data = await Promise.all(page.map(toHook));
        const hasMore = offset + limit < hooks.length;

        return {
          data,
          cursor: hasMore ? String(offset + limit) : null,
          hasMore,
        };
      },
      list: notImplemented("hooks.list"),
    } as unknown as World["hooks"],
  } as unknown as World;
}
