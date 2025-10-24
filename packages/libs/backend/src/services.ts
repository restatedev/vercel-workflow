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

import {
  Context,
  createObjectHandler,
  createServiceHandler,
  object,
  ObjectContext,
  RestatePromise, RetryableError,
  service,
  TerminalError,
} from "@restatedev/restate-sdk";

import {
  type CancelWorkflowRunParams,
  type CreateWorkflowRunRequest,
  type GetWorkflowRunParams,
  type ListWorkflowRunsParams,
  type PaginatedResponse,
  type PauseWorkflowRunParams,
  type ResumeWorkflowRunParams,
  type UpdateWorkflowRunRequest,
  type WorkflowRun,
  type Step,
  type CreateStepRequest,
  type GetStepParams,
  type UpdateStepRequest,
  type Hook,
  type CreateHookRequest,
  type GetHookParams,
  type Event,
  type CreateEventRequest,
  type ListEventsParams,
  ListWorkflowRunStepsParams,
  ListEventsByCorrelationIdParams,
  ValidQueueName,
  QueuePayload,
  WorkflowRunSchema,
  StepSchema,
  EventSchema,
  HookSchema,
} from "@workflow/world";
import {
  DEFAULT_RESOLVE_DATA_OPTION,
  filterRunData,
  filterStepData,
  filterHookData,
  filterEventData,
} from "./utils.js";

import { JsonTransport } from "@vercel/queue";
import { QueueParamsSchema, serde } from "@restatedev/common";

// key by runId

export type State = { run: WorkflowRun; lastEventId: number } & {
  [key in `step_${string}`]: Step;
} & {
  [key in `evnt_${string}`]: Event;
};

export type WorkflowContext = ObjectContext<State>;

export const workflowApi = object({
  name: "workflow",
  handlers: {
    // runs ------------------------------------------------------------------

    createRun: createObjectHandler(
      {
        output: serde.zod(WorkflowRunSchema),
      },
      async (
        ctx: WorkflowContext,
        data: CreateWorkflowRunRequest
      ): Promise<WorkflowRun> => {
        const existing = await ctx.get("run");
        if (existing) {
          throw new TerminalError("Workflow run already exists", {
            errorCode: 409,
          });
        }

        const runId = ctx.key;
        const now = new Date();

        const result: WorkflowRun = {
          runId,
          deploymentId: data.deploymentId,
          status: "pending",
          workflowName: data.workflowName,
          executionContext: data.executionContext as
            | Record<string, any>
            | undefined,
          input: (data.input as any[]) || [],
          output: undefined,
          error: undefined,
          errorCode: undefined,
          startedAt: undefined,
          completedAt: undefined,
          createdAt: now,
          updatedAt: now,
        };

        ctx.set("run", result);

        return result;
      }
    ),

    getRun: createObjectHandler(
      {
        output: serde.zod(WorkflowRunSchema),
      },
      async (ctx: WorkflowContext, params?: GetWorkflowRunParams) => {
        const run = await ctx.get("run");
        if (!run) {
          throw new TerminalError("Workflow run not found", { errorCode: 404 });
        }
        const resolveData = params?.resolveData ?? DEFAULT_RESOLVE_DATA_OPTION;
        return filterRunData(run, resolveData);
      }
    ),

    updateRun: createObjectHandler(
      {
        output: serde.zod(WorkflowRunSchema),
      },
      async (
        ctx: WorkflowContext,
        data: UpdateWorkflowRunRequest
      ): Promise<WorkflowRun> => {
        const run = await ctx.get("run");
        if (!run) {
          throw new TerminalError("Workflow run not found", { errorCode: 404 });
        }

        const now = new Date();
        const updatedRun: WorkflowRun = {
          ...run,
          ...data,
          updatedAt: now,
        };

        // Only set startedAt the first time the run transitions to 'running'
        if (data.status === "running" && !updatedRun.startedAt) {
          updatedRun.startedAt = now;
        }
        if (
          data.status === "completed" ||
          data.status === "failed" ||
          data.status === "cancelled"
        ) {
          updatedRun.completedAt = now;
        }

        ctx.set("run", updatedRun);

        return updatedRun;
      }
    ),

    cancelRun: createObjectHandler(
      {
        output: serde.zod(WorkflowRunSchema),
      },
      async (ctx: WorkflowContext, params?: CancelWorkflowRunParams) => {
        // Inline updateRun logic for status change
        const run = await ctx.get("run");
        if (!run) {
          throw new TerminalError("Workflow run not found", { errorCode: 404 });
        }

        const now = new Date();
        const updatedRun: WorkflowRun = {
          ...run,
          status: "cancelled",
          updatedAt: now,
          completedAt: now,
        };

        ctx.set("run", updatedRun);

        const resolveData = params?.resolveData ?? DEFAULT_RESOLVE_DATA_OPTION;
        return filterRunData(updatedRun, resolveData);
      }
    ),

    pauseRun: createObjectHandler(
      {
        output: serde.zod(WorkflowRunSchema),
      },
      async (ctx: WorkflowContext, params?: PauseWorkflowRunParams) => {
        // Inline updateRun logic for status change
        const run = await ctx.get("run");
        if (!run) {
          throw new TerminalError("Workflow run not found", { errorCode: 404 });
        }

        const now = new Date();
        const updatedRun: WorkflowRun = {
          ...run,
          status: "paused",
          updatedAt: now,
        };

        ctx.set("run", updatedRun);

        const resolveData = params?.resolveData ?? DEFAULT_RESOLVE_DATA_OPTION;
        return filterRunData(updatedRun, resolveData);
      }
    ),

    resumeRun: createObjectHandler(
      {
        output: serde.zod(WorkflowRunSchema),
      },
      async (ctx: WorkflowContext, params?: ResumeWorkflowRunParams) => {
        // Inline updateRun logic for status change
        const run = await ctx.get("run");
        if (!run) {
          throw new TerminalError("Workflow run not found", { errorCode: 404 });
        }

        const now = new Date();
        const updatedRun: WorkflowRun = {
          ...run,
          status: "running",
          updatedAt: now,
        };

        // Only set startedAt the first time the run transitions to 'running'
        if (!updatedRun.startedAt) {
          updatedRun.startedAt = now;
        }

        ctx.set("run", updatedRun);

        const resolveData = params?.resolveData ?? DEFAULT_RESOLVE_DATA_OPTION;
        return filterRunData(updatedRun, resolveData);
      }
    ),

    // steps ------------------------------------------------------------------

    createStep: createObjectHandler(
      {
        output: serde.zod(StepSchema),
      },
      async (ctx: WorkflowContext, data: CreateStepRequest) => {
        const stepKey = `step_${data.stepId}` as const;
        const existing = await ctx.get(stepKey);
        if (existing) {
          throw new TerminalError("Step already exists", {
            errorCode: 409,
          });
        }

        const now = new Date();

        const result: Step = {
          runId: ctx.key,
          stepId: data.stepId,
          stepName: data.stepName,
          status: "pending",
          input: data.input as any[],
          output: undefined,
          error: undefined,
          errorCode: undefined,
          attempt: 0,
          startedAt: undefined,
          completedAt: undefined,
          createdAt: now,
          updatedAt: now,
        };

        ctx.set(stepKey, result);

        return result;
      }
    ),

    getStep: createObjectHandler(
      {
        output: serde.zod(StepSchema),
      },
      async (
        ctx: WorkflowContext,
        params: { stepId: string } & GetStepParams
      ) => {
        const stepKey = `step_${params.stepId}` as const;
        const step = await ctx.get(stepKey);
        if (!step) {
          throw new TerminalError("Step not found", { errorCode: 404 });
        }
        const resolveData = params?.resolveData ?? DEFAULT_RESOLVE_DATA_OPTION;
        return filterStepData(step, resolveData);
      }
    ),

    updateStep: createObjectHandler(
      {
        output: serde.zod(StepSchema),
      },
      async (
        ctx: WorkflowContext,
        params: { stepId: string } & UpdateStepRequest
      ) => {
        const stepKey = `step_${params.stepId}` as const;
        const step = await ctx.get(stepKey);
        if (!step) {
          throw new TerminalError("Step not found", { errorCode: 404 });
        }

        const now = new Date();
        const updatedStep: Step = {
          ...step,
          ...params,
          updatedAt: now,
        };

        // Only set startedAt the first time the step transitions to 'running'
        if (params.status === "running" && !updatedStep.startedAt) {
          updatedStep.startedAt = now;
        }
        if (params.status === "completed" || params.status === "failed") {
          updatedStep.completedAt = now;
        }

        ctx.set(stepKey, updatedStep);

        return updatedStep;
      }
    ),

    listSteps: createObjectHandler(
      {
        output: serde.zod(StepSchema.array()),
      },
      async (ctx: WorkflowContext, params: ListWorkflowRunStepsParams) => {
        const resolveData = params.resolveData ?? DEFAULT_RESOLVE_DATA_OPTION;
        const allKeys = (await ctx.stateKeys()) ?? [];
        const stepKeys = allKeys.filter((key) => key.startsWith("step_"));
        if (stepKeys.length === 0) {
          return [];
        }
        const steps = await RestatePromise.all(
          stepKeys.map(
            (key) => ctx.get(key as any) as unknown as RestatePromise<Step>
          )
        );

        if (resolveData === "none") {
          return steps.map((step) => ({
            ...step,
            input: [],
            output: undefined,
          }));
        }

        return steps;
      }
    ),

    // events ------------------------------------------------------------------

    createEvent: createObjectHandler(
      {
        output: serde.zod(EventSchema),
      },
      async (
        ctx: WorkflowContext,
        data: CreateEventRequest & { resolveData?: "none" | "all" }
      ) => {
        let lastEventId = (await ctx.get("lastEventId")) ?? 0;
        lastEventId += 1;
        ctx.set("lastEventId", lastEventId);
        
        const eventId = `evnt_${lastEventId}` as const;

        const now = new Date();

        const result: Event = {
          ...data,
          runId: ctx.key,
          eventId,
          createdAt: now,
        };

        ctx.set(eventId, result);

        if (data.correlationId) {
          ctx.objectSendClient(keyValue, data.correlationId).append(ctx.key);
        }

        const resolveData = data.resolveData ?? DEFAULT_RESOLVE_DATA_OPTION;
        return filterEventData(result, resolveData);
      }
    ),

    listEvents: createObjectHandler(
      {
        output: serde.zod(EventSchema.array()),
      },
      async (
        ctx: WorkflowContext,
        params: Omit<ListEventsParams, "runId"> // because it is already part of the key
      ): Promise<Event[]> => {
        const resolveData = params.resolveData ?? DEFAULT_RESOLVE_DATA_OPTION;
        const allKeys = (await ctx.stateKeys()) ?? [];
        const eventKeys = allKeys.filter((key) => key.startsWith("evnt_"));
        if (eventKeys.length === 0) {
          return [];
        }
        const events = await RestatePromise.all(
          eventKeys.map(
            (key) => ctx.get(key as any) as unknown as RestatePromise<Event>
          )
        );

        const sign = params.pagination?.sortOrder === "desc" ? -1 : 1;

        const sortedEvents = events.sort((a, b) => {
          const aId = parseInt(a.eventId.substring("evnt_".length));
          const bId = parseInt(b.eventId.substring("evnt_".length));
          return (aId - bId) * sign;
        });

        if (resolveData === "none") {
          return sortedEvents.map((event) => {
            const { eventData: _eventData, ...rest } = event as any;
            return rest;
          });
        }

        return sortedEvents;
      }
    ),
  },

  options: {
    enableLazyState: true,
  },
});

export type HookContext = ObjectContext<{ hook: Hook }>;

export const hooksApi = object({
  name: "hooks",
  handlers: {
    create: createObjectHandler(
      {
        output: serde.zod(HookSchema),
      },
      async (ctx: HookContext, data: CreateHookRequest & { runId: string }) => {
        const existing = await ctx.get("hook");
        if (existing) {
          throw new TerminalError("Hook already exists", {
            errorCode: 409,
          });
        }

        const hookId = ctx.key;
        const now = new Date();

        const result: Hook = {
          runId: data.runId,
          hookId,
          token: data.token,
          metadata: data.metadata,
          ownerId: "embedded-owner",
          projectId: "embedded-project",
          environment: "embedded",
          createdAt: now,
        };

        ctx.set("hook", result);

        if (data.token) {
          ctx.objectSendClient(keyValue, data.token).append(hookId);
        }

        return result;
      }
    ),

    get: createObjectHandler(
      {
        output: serde.zod(HookSchema),
      },
      async (ctx: HookContext, params?: GetHookParams) => {
        const hook = await ctx.get("hook");
        if (!hook) {
          throw new TerminalError("Hook not found", { errorCode: 404 });
        }
        const resolveData = params?.resolveData ?? DEFAULT_RESOLVE_DATA_OPTION;
        return filterHookData(hook, resolveData);
      }
    ),

    dispose: createObjectHandler(
      {
        output: serde.zod(HookSchema),
      },
      async (ctx: HookContext) => {
        const hook = await ctx.get("hook");
        if (!hook) {
          throw new TerminalError("Hook not found", { errorCode: 404 });
        }

        ctx.clear("hook");

        if (hook.token) {
          ctx.objectSendClient(keyValue, hook.token).clear();
        }

        return hook;
      }
    ),
  },
  options: {
    enableLazyState: true,
  },
});

export const keyValue = object({
  name: "kv",
  handlers: {
    get: async (ctx: ObjectContext) => {
      return (await ctx.get<unknown[]>("value")) ?? [];
    },

    set: async (ctx: ObjectContext, value: unknown[]) => {
      ctx.set("value", value);
    },

    clear: async (ctx: ObjectContext) => {
      ctx.clear("value");
    },

    append: async (ctx: ObjectContext, value: unknown) => {
      const existing = await ctx.get<unknown[]>("value");
      const newValue = existing ? [...existing, value] : [value];
      ctx.set("value", newValue);
    },
  },
});

export const indexService = service({
  name: "indexService",
  handlers: {
    getEventsByCorrelationId: createServiceHandler(
      {
        output: serde.zod(EventSchema.array()),
      },
      async (
        ctx: Context,
        param: ListEventsByCorrelationIdParams
      ): Promise<Event[]> => {
        const runIds = (await ctx
          .objectClient(keyValue, param.correlationId)
          .get()) as string[];

        const matchingEvents: Event[] = [];
        for (const runId of runIds || []) {
          const events = await ctx
            .objectClient(workflowApi, runId)
            .listEvents({ resolveData: param.resolveData });

          matchingEvents.push(
            ...events.filter(
              (event) => event.correlationId === param.correlationId
            )
          );
        }
        return matchingEvents;
      }
    ),

    getHookByToken: createServiceHandler(
      {
        output: serde.zod(HookSchema),
      },
      async (ctx: Context, param: { token: string }): Promise<Hook> => {
        const hookTokens = (await ctx
          .objectClient(keyValue, param.token)
          .get()) as { runId: string; hookId: string }[];

        if (hookTokens === undefined || hookTokens.length === 0) {
          throw new TerminalError("No hooks found", { errorCode: 404 });
        }
        const theHook = hookTokens[0];
        const hook = await ctx.objectClient(hooksApi, theHook!.hookId).get({});
        return hook;
      }
    ),

    listRun: createServiceHandler(
      {
        output: serde.zod(WorkflowRunSchema.array()),
      },
      async (ctx: Context, arg: { params?: ListWorkflowRunsParams}) => {
        throw new TerminalError("Unimplemented yet", { errorCode: 501 });
      }
    ),
  },
});

const transport = new JsonTransport();

export const queue = service({
  name: "queueService",
  handlers: {
    queue: createServiceHandler(
      {
        retryPolicy: {
          maxAttempts: 10,
          maxInterval: { seconds: 6 },
          onMaxAttempts: "kill",
        },

        input: serde.zod(QueueParamsSchema),
      },
      async (ctx: Context, params) => {
        let pathname: string;
        if (params.queueName.startsWith("__wkf_step_")) {
          pathname = `step`;
        } else if (params.queueName.startsWith("__wkf_workflow_")) {
          pathname = `flow`;
        } else {
          throw new Error("Unknown queue name prefix");
        }

        const messageId = ctx.request().id;

        const body = transport.serialize(params.message);

        const response = await fetch(
          `${params.deliverTo}/.well-known/workflow/v1/${pathname}`,
          {
            method: "POST",
            body: body as BodyInit,
            headers: {
              "x-vqs-queue-name": params.queueName,
              "x-vqs-message-id": messageId,
              "x-vqs-message-attempt": String(1), // TODO: fix this.
            },
          }
        );

        if (response.ok) {
          return;
        }
        if (response.status === 503) {
          const {retryIn} = await response.json();
          throw new RetryableError("Retrying", {
            errorCode: 503,
            retryAfter: { seconds: retryIn },
          });
        }

        const text = await response.text();
        throw new Error(
          `Queue delivery failed with status ${response.status}:\n${text}`
        );
      }
    ),
  },
});

export type IndexService = typeof indexService;
export type WorkflowApi = typeof workflowApi;
export type HooksApi = typeof hooksApi;
export type QueueService = typeof queue;
