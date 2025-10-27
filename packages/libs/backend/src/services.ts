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
  RestatePromise,
  service,
  TerminalError,
} from "@restatedev/restate-sdk";

import {
  type CancelWorkflowRunParams,
  type CreateEventRequest,
  type CreateHookRequest,
  type CreateStepRequest,
  type CreateWorkflowRunRequest,
  type Event,
  EventSchema,
  type GetHookParams,
  type GetStepParams,
  type GetWorkflowRunParams,
  type Hook,
  HookSchema,
  ListEventsByCorrelationIdParams,
  type ListEventsParams,
  ListHooksParams,
  type ListWorkflowRunsParams,
  ListWorkflowRunStepsParams,
  type PauseWorkflowRunParams,
  type ResumeWorkflowRunParams,
  type Step,
  StepSchema,
  type UpdateStepRequest,
  type UpdateWorkflowRunRequest,
  type WorkflowRun,
  WorkflowRunSchema,
} from "@workflow/world";
import {
  DEFAULT_RESOLVE_DATA_OPTION,
  filterEventData,
  filterHookData,
  filterRunData,
  filterStepData,
  getStateKeysByPrefix,
} from "./utils.js";

import { serde } from "@restatedev/restate-sdk-zod";

// key by runId

export type State = { run: WorkflowRun; lastEventId: number } & {
  [key in `step_${string}`]: Step;
} & {
  [key in `evnt_${string}`]: Event;
} & {
  [key in `hook_${string}`]: Hook;
};

export type WorkflowContext = ObjectContext<State>;

export const workflow = object({
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
        const existing = await ctx.get("run", serde.zod(WorkflowRunSchema));
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

        ctx.set("run", result, serde.zod(WorkflowRunSchema));

        return result;
      }
    ),

    getRun: createObjectHandler(
      {
        output: serde.zod(WorkflowRunSchema),
      },
      async (ctx: WorkflowContext, params: GetWorkflowRunParams) => {
        const run = await ctx.get("run", serde.zod(WorkflowRunSchema));
        if (!run) {
          throw new TerminalError("Workflow run not found", { errorCode: 404 });
        }
        return filterRunData(run, params?.resolveData);
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
        const run = await ctx.get("run", serde.zod(WorkflowRunSchema));
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

        ctx.set("run", updatedRun, serde.zod(WorkflowRunSchema));

        return updatedRun;
      }
    ),

    cancelRun: createObjectHandler(
      {
        output: serde.zod(WorkflowRunSchema),
      },
      async (ctx: WorkflowContext, params: CancelWorkflowRunParams) => {
        // Inline updateRun logic for status change
        const run = await ctx.get("run", serde.zod(WorkflowRunSchema));
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

        ctx.set("run", updatedRun, serde.zod(WorkflowRunSchema));

        return filterRunData(updatedRun, params?.resolveData);
      }
    ),

    pauseRun: createObjectHandler(
      {
        output: serde.zod(WorkflowRunSchema),
      },
      async (ctx: WorkflowContext, params: PauseWorkflowRunParams) => {
        // Inline updateRun logic for status change
        const run = await ctx.get("run", serde.zod(WorkflowRunSchema));
        if (!run) {
          throw new TerminalError("Workflow run not found", { errorCode: 404 });
        }

        const now = new Date();
        const updatedRun: WorkflowRun = {
          ...run,
          status: "paused",
          updatedAt: now,
        };

        ctx.set("run", updatedRun, serde.zod(WorkflowRunSchema));

        return filterRunData(updatedRun, params?.resolveData);
      }
    ),

    resumeRun: createObjectHandler(
      {
        output: serde.zod(WorkflowRunSchema),
      },
      async (ctx: WorkflowContext, params: ResumeWorkflowRunParams) => {
        // Inline updateRun logic for status change
        const run = await ctx.get("run", serde.zod(WorkflowRunSchema));
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

        ctx.set("run", updatedRun, serde.zod(WorkflowRunSchema));

        return filterRunData(updatedRun, params?.resolveData);
      }
    ),

    // steps ------------------------------------------------------------------

    createStep: createObjectHandler(
      {
        output: serde.zod(StepSchema),
      },
      async (ctx: WorkflowContext, data: CreateStepRequest) => {
        const stepKey = `step_${data.stepId}` as const;
        const existing = await ctx.get(stepKey, serde.zod(StepSchema));
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

        ctx.set(stepKey, result, serde.zod(StepSchema));

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
        const step = await ctx.get(stepKey, serde.zod(StepSchema));
        if (!step) {
          throw new TerminalError("Step not found", { errorCode: 404 });
        }
        return filterStepData(step, params?.resolveData);
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
        const step = await ctx.get(stepKey, serde.zod(StepSchema));
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

        ctx.set(stepKey, updatedStep, serde.zod(StepSchema));

        return updatedStep;
      }
    ),

    listSteps: createObjectHandler(
      {
        output: serde.zod(StepSchema.array()),
      },
      async (ctx: WorkflowContext, params: ListWorkflowRunStepsParams) => {
        const stepKeys = await getStateKeysByPrefix(ctx, "step_");
        if (stepKeys.length === 0) {
          return [];
        }

        const orderingSign = params.pagination?.sortOrder === "asc" ? 1 : -1;
        return (
          (
            await RestatePromise.all(
              stepKeys.map(
                (key) =>
                  ctx.get(
                    key as any,
                    serde.zod(StepSchema) as any
                  ) as unknown as RestatePromise<Step>
              )
            )
          )
            // Sort as requested
            .sort(
              (a, b) =>
                (a.createdAt.getTime() - b.createdAt.getTime()) * orderingSign
            )
            // Filter data
            .map((step) => filterStepData(step, params.resolveData))
        );
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

        ctx.set(eventId, result, serde.zod(EventSchema));

        if (data.correlationId) {
          ctx.objectSendClient(keyValue, data.correlationId).append(ctx.key);
        }

        return filterEventData(result, data.resolveData);
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
        const eventKeys = await getStateKeysByPrefix(ctx, "evnt_");
        if (eventKeys.length === 0) {
          return [];
        }

        const orderingSign = params.pagination?.sortOrder === "desc" ? -1 : 1;
        return (
          (
            await RestatePromise.all(
              eventKeys.map(
                (key) =>
                  ctx.get(
                    key as any,
                    serde.zod(EventSchema) as any
                  ) as unknown as RestatePromise<Event>
              )
            )
          )
            // Sort as requested
            .sort(
              (a, b) =>
                (a.createdAt.getTime() - b.createdAt.getTime()) * orderingSign
            )
            // Filter data
            .map((event) => filterEventData(event, params.resolveData))
        );
      }
    ),

    // -- Hooks

    createHook: createObjectHandler(
      {
        output: serde.zod(HookSchema),
      },
      async (ctx: WorkflowContext, data: CreateHookRequest) => {
        const hookKey = `hook_${data.hookId}` as const;
        const existing = await ctx.get(hookKey, serde.zod(HookSchema));
        if (existing) {
          throw new TerminalError("Hook already exists", {
            errorCode: 409,
          });
        }

        const now = new Date();

        const result: Hook = {
          runId: ctx.key,
          hookId: data.hookId,
          token: data.token,
          metadata: data.metadata,
          ownerId: "restate-owner",
          projectId: "restate-project",
          environment: "restate",
          createdAt: now,
        };

        ctx.set(hookKey, result, serde.zod(HookSchema));

        // Build index
        ctx.objectSendClient(keyValue, data.hookId).append(ctx.key);
        if (data.token) {
          ctx
            .objectSendClient(keyValue, data.token)
            .append({ runId: ctx.key, hookId: data.hookId });
        }

        return result;
      }
    ),

    getHook: createObjectHandler(
      {
        output: serde.zod(HookSchema),
      },
      async (
        ctx: WorkflowContext,
        params: GetHookParams & { hookId: string }
      ) => {
        const hook = await ctx.get(
          `hook_${params.hookId}`,
          serde.zod(HookSchema)
        );
        if (!hook) {
          throw new TerminalError("Hook not found", { errorCode: 404 });
        }
        return filterHookData(hook, params?.resolveData);
      }
    ),

    listHooks: createObjectHandler(
      {
        output: serde.zod(HookSchema.array()),
      },
      async (
        ctx: WorkflowContext,
        params: Omit<ListHooksParams, "runId"> // because it is already part of the key
      ): Promise<Hook[]> => {
        const hookKeys = await getStateKeysByPrefix(ctx, "hook_");
        if (hookKeys.length === 0) {
          return [];
        }

        const orderingSign = params.pagination?.sortOrder === "asc" ? -1 : 1;
        return (
          (
            await RestatePromise.all(
              hookKeys.map(
                (key) =>
                  ctx.get(
                    key as any,
                    serde.zod(HookSchema) as any
                  ) as unknown as RestatePromise<Hook>
              )
            )
          )
            // Sort as requested
            .sort(
              (a, b) =>
                (a.createdAt.getTime() - b.createdAt.getTime()) * orderingSign
            )
            // Filter data
            .map((hook) => filterHookData(hook, params.resolveData))
        );
      }
    ),

    disposeHook: createObjectHandler(
      {
        output: serde.zod(HookSchema),
      },
      async (
        ctx: WorkflowContext,
        params: { hookId: string } & GetHookParams
      ) => {
        const hookKey = `hook_${params.hookId}` as const;
        const hook = await ctx.get(hookKey, serde.zod(HookSchema));
        if (!hook) {
          throw new TerminalError("Hook not found", { errorCode: 404 });
        }

        ctx.clear(hookKey);

        // Clear index
        ctx.objectSendClient(keyValue, hook.hookId).clear();
        if (hook.token) {
          ctx.objectSendClient(keyValue, hook.token).clear();
        }

        return filterHookData(hook, params.resolveData);
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

export const index = service({
  name: "index",
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
            .objectClient(workflow, runId)
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

    getHookById: createServiceHandler(
      {
        output: serde.zod(HookSchema),
      },
      async (
        ctx: Context,
        param: { hookId: string } & GetHookParams
      ): Promise<Hook> => {
        const runId = (await ctx
          .objectClient(keyValue, param.hookId)
          .get()) as string[];

        if (runId === undefined || runId.length === 0) {
          throw new TerminalError("No hooks found", { errorCode: 404 });
        }
        return await ctx.objectClient(workflow, runId[0]!).getHook({
          hookId: param.hookId,
          resolveData: param.resolveData,
        });
      }
    ),

    getHookByToken: createServiceHandler(
      {
        output: serde.zod(HookSchema),
      },
      async (
        ctx: Context,
        param: { token: string } & GetHookParams
      ): Promise<Hook> => {
        const runIdAndHookId = (await ctx
          .objectClient(keyValue, param.token)
          .get()) as { runId: string; hookId: string }[];

        if (runIdAndHookId === undefined || runIdAndHookId.length === 0) {
          throw new TerminalError("No hooks found", { errorCode: 404 });
        }
        return await ctx
          .objectClient(workflow, runIdAndHookId[0]!.runId)
          .getHook({
            hookId: runIdAndHookId[0]!.hookId,
            resolveData: param.resolveData,
          });
      }
    ),

    listRun: createServiceHandler(
      {
        output: serde.zod(WorkflowRunSchema.array()),
      },
      async (ctx: Context, params: ListWorkflowRunsParams) => {
        throw new TerminalError("Unimplemented yet", { errorCode: 501 });
      }
    ),

    listHooks: createServiceHandler(
      {
        output: serde.zod(WorkflowRunSchema.array()),
      },
      async (ctx: Context, params: ListWorkflowRunsParams) => {
        throw new TerminalError("Unimplemented yet", { errorCode: 501 });
      }
    ),
  },
  options: {
    // No need to have journal retention for this service, as it just performs reads
    journalRetention: { milliseconds: 0 },
  },
});

export type IndexApi = typeof index;
export type WorkflowApi = typeof workflow;
