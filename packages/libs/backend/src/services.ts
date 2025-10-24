
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
  object,
  ObjectContext,
  RestatePromise,
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
} from "@workflow/world";
import {
  DEFAULT_RESOLVE_DATA_OPTION,
  filterRunData,
  filterStepData,
  filterHookData,
  filterEventData,
} from "./utils.js";

// key by runId

export type State = { run: WorkflowRun } & {
  [key in `step_${string}`]: Step;
} & {
  [key in `event_${string}`]: Event;
};

export type WorkflowContext = ObjectContext<State>;

export const workflowApi = object({
  name: "workflow",
  handlers: {
    // runs ------------------------------------------------------------------

    async createRun(ctx: WorkflowContext, data: CreateWorkflowRunRequest) {
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

      return {};
    },

    async getRun(ctx: WorkflowContext, params?: GetWorkflowRunParams) {
      const run = await ctx.get("run");
      if (!run) {
        throw new TerminalError("Workflow run not found", { errorCode: 404 });
      }
      const resolveData = params?.resolveData ?? DEFAULT_RESOLVE_DATA_OPTION;
      return filterRunData(run, resolveData);
    },

    async updateRun(ctx: WorkflowContext, data: UpdateWorkflowRunRequest) {
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
    },

    async listRun(
      ctx: WorkflowContext,
      data?: ListWorkflowRunsParams
    ): Promise<PaginatedResponse<WorkflowRun>> {
      // TODO: Implement listing workflow runs
      throw new TerminalError("Not implemented", { errorCode: 501 });

      /*
      const resolveData = params?.resolveData ?? DEFAULT_RESOLVE_DATA_OPTION;
      const result = await paginatedFileSystemQuery({
        directory: path.join(basedir, "runs"),
        schema: WorkflowRunSchema,
        filter: params?.workflowName
          ? (run) => run.workflowName === params.workflowName
          : undefined,
        sortOrder: params?.pagination?.sortOrder ?? "desc",
        limit: params?.pagination?.limit,
        cursor: params?.pagination?.cursor,
        getCreatedAt: getObjectCreatedAt("wrun"),
        getId: (run) => run.runId,
      });

      // If resolveData is "none", replace input/output with empty data
      if (resolveData === "none") {
        return {
          ...result,
          data: result.data.map((run) => ({
            ...run,
            input: [],
            output: undefined,
          })),
        };
      }

      return result;
      */
    },

    async cancelRun(ctx: WorkflowContext, params?: CancelWorkflowRunParams) {
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
    },

    async pauseRun(ctx: WorkflowContext, params?: PauseWorkflowRunParams) {
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
    },

    async resumeRun(ctx: WorkflowContext, params?: ResumeWorkflowRunParams) {
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
    },

    // steps ------------------------------------------------------------------

    async createStep(ctx: WorkflowContext, data: CreateStepRequest) {
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
    },

    async getStep(
      ctx: WorkflowContext,
      params: { stepId: string } & GetStepParams
    ) {
      const stepKey = `step_${params.stepId}` as const;
      const step = await ctx.get(stepKey);
      if (!step) {
        throw new TerminalError("Step not found", { errorCode: 404 });
      }
      const resolveData = params?.resolveData ?? DEFAULT_RESOLVE_DATA_OPTION;
      return filterStepData(step, resolveData);
    },

    async updateStep(
      ctx: WorkflowContext,
      params: { stepId: string } & UpdateStepRequest
    ) {
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
    },

    async listSteps(ctx: WorkflowContext, params: ListWorkflowRunStepsParams) {
      const resolveData = params.resolveData ?? DEFAULT_RESOLVE_DATA_OPTION;
      const allKeys = (await ctx.stateKeys()) ?? [];
      const stepKeys = allKeys.filter((key) => key.startsWith("step_"));
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
    },

    // events ------------------------------------------------------------------

    async createEvent(
      ctx: WorkflowContext,
      data: CreateEventRequest,
      params?: { resolveData?: "none" | "all" }
    ) {
      // Generate a unique event ID using current timestamp and random component
      const eventId = `evnt_${ctx.rand.uuidv4()}`;
      const eventKey = `event_${eventId}` as const;

      const now = new Date();

      const result: Event = {
        ...data,
        runId: ctx.key,
        eventId,
        createdAt: now,
      };

      ctx.set(eventKey, result);

      if (data.correlationId) {
        ctx.objectSendClient(keyValue, data.correlationId).append(ctx.key);
      }

      const resolveData = params?.resolveData ?? DEFAULT_RESOLVE_DATA_OPTION;
      return filterEventData(result, resolveData);
    },

    async listEvents(
      ctx: WorkflowContext,
      params: Omit<ListEventsParams, "runId"> // because it is already part of the key
    ): Promise<Event[]> {
      const resolveData = params.resolveData ?? DEFAULT_RESOLVE_DATA_OPTION;
      const allKeys = (await ctx.stateKeys()) ?? [];
      const eventKeys = allKeys.filter((key) => key.startsWith("event_"));
      const events = await RestatePromise.all(
        eventKeys.map(
          (key) => ctx.get(key as any) as unknown as RestatePromise<Event>
        )
      );

      if (resolveData === "none") {
        return events.map((event) => {
          const { eventData: _eventData, ...rest } = event as any;
          return rest;
        });
      }

      return events;
    },
  },

  options: {
    enableLazyState: true,
  },
});

export type HookContext = ObjectContext<{ hook: Hook }>;

export const hooksApi = object({
  name: "hooks",
  handlers: {
    async create(
      ctx: HookContext,
      data: CreateHookRequest & { runId: string }
    ) {
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
    },

    async get(ctx: HookContext, params?: GetHookParams) {
      const hook = await ctx.get("hook");
      if (!hook) {
        throw new TerminalError("Hook not found", { errorCode: 404 });
      }
      const resolveData = params?.resolveData ?? DEFAULT_RESOLVE_DATA_OPTION;
      return filterHookData(hook, resolveData);
    },

    async dispose(ctx: HookContext) {
      const hook = await ctx.get("hook");
      if (!hook) {
        throw new TerminalError("Hook not found", { errorCode: 404 });
      }

      ctx.clear("hook");

      if (hook.token) {
        ctx.objectSendClient(keyValue, hook.token).clear();
      }

      return hook;
    },
  },
  options: {
    enableLazyState: true,
  },
});

export const keyValue = object({
  name: "kv",
  handlers: {
    async get(ctx: ObjectContext) {
      return (await ctx.get<unknown[]>("value")) ?? [];
    },

    async set(ctx: ObjectContext, value: unknown[]) {
      ctx.set("value", value);
    },

    async clear(ctx: ObjectContext) {
      ctx.clear("value");
    },

    async append(ctx: ObjectContext, value: unknown) {
      const existing = await ctx.get<unknown[]>("value");
      const newValue = existing ? [...existing, value] : [value];
      ctx.set("value", newValue);
    },
  },
});

export const indexService = service({
  name: "indexService",
  handlers: {
    async getEventsByCorrelationId(
      ctx: Context,
      param: ListEventsByCorrelationIdParams
    ): Promise<Event[]> {
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
    },

    async getHookByToken(
      ctx: Context,
      param: { token: string }
    ): Promise<Hook> {
      const hookTokens = (await ctx
        .objectClient(keyValue, param.token)
        .get()) as { runId: string; hookId: string }[];

      if (hookTokens === undefined || hookTokens.length === 0) {
        throw new TerminalError("No hooks found", { errorCode: 404 });
      }
      const theHook = hookTokens[0];
      const hook = await ctx.objectClient(hooksApi, theHook!.hookId).get();
      return hook;
    },
  },
});


export type IndexService = typeof indexService;
export type WorkflowApi = typeof workflowApi;
export type HooksApi = typeof hooksApi; 