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

import { object, ObjectContext, TerminalError } from "@restatedev/restate-sdk";

import {
  WorkflowRunSchema,
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
} from "@workflow/world";
import {
  DEFAULT_RESOLVE_DATA_OPTION,
  filterRunData,
  filterStepData,
  filterHookData,
} from "./utils.js";

// key by runId

type StepKey = `step_${string}`;
type HookKey = `hook_${string}`;

export type WorkflowContext = ObjectContext<
  {
    [key in StepKey]: Step;
  } & { [key in HookKey]: Hook } & { run: WorkflowRun }
>;

// key by stepId
export type StepContext = ObjectContext<{ step: Step }>;

// key by hookId
export type HookContext = ObjectContext<{ hook: Hook }>;

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
      const run = await this.updateRun(ctx, { status: "cancelled" });
      const resolveData = params?.resolveData ?? DEFAULT_RESOLVE_DATA_OPTION;
      return filterRunData(run, resolveData);
    },

    async pauseRun(ctx: WorkflowContext, params?: PauseWorkflowRunParams) {
      const run = await this.updateRun(ctx, { status: "paused" });
      const resolveData = params?.resolveData ?? DEFAULT_RESOLVE_DATA_OPTION;
      return filterRunData(run, resolveData);
    },

    async resumeRun(ctx: WorkflowContext, params?: ResumeWorkflowRunParams) {
      const run = await this.updateRun(ctx, { status: "running" });
      const resolveData = params?.resolveData ?? DEFAULT_RESOLVE_DATA_OPTION;
      return filterRunData(run, resolveData);
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

    // hooks ------------------------------------------------------------------
  },
  options: {
    enableLazyState: true,
  },
});

export const stepsApi = object({
  name: "steps",
  handlers: {
    async create(ctx: StepContext, data: CreateStepRequest) {
      const existing = await ctx.get("step");
      if (existing) {
        throw new TerminalError("Step already exists", {
          errorCode: 409,
        });
      }

      const stepId = ctx.key;
      const now = new Date();

      const result: Step = {
        runId: "virtual-run", // Virtual objects don't need filesystem-style runId tracking
        stepId,
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

      ctx.set("step", result);

      return result;
    },

    async get(ctx: StepContext, params?: GetStepParams) {
      const step = await ctx.get("step");
      if (!step) {
        throw new TerminalError("Step not found", { errorCode: 404 });
      }
      const resolveData = params?.resolveData ?? DEFAULT_RESOLVE_DATA_OPTION;
      return filterStepData(step, resolveData);
    },

    async update(ctx: StepContext, data: UpdateStepRequest) {
      const step = await ctx.get("step");
      if (!step) {
        throw new TerminalError("Step not found", { errorCode: 404 });
      }

      const now = new Date();
      const updatedStep: Step = {
        ...step,
        ...data,
        updatedAt: now,
      };

      // Only set startedAt the first time the step transitions to 'running'
      if (data.status === "running" && !updatedStep.startedAt) {
        updatedStep.startedAt = now;
      }
      if (data.status === "completed" || data.status === "failed") {
        updatedStep.completedAt = now;
      }

      ctx.set("step", updatedStep);

      return updatedStep;
    },

    // Lists are not implemented yet as per instructions
  },
  options: {
    enableLazyState: true,
  },
});

export const hooksApi = object({
  name: "hooks",
  handlers: {
    async create(ctx: HookContext, data: CreateHookRequest) {
      const existing = await ctx.get("hook");
      if (existing) {
        throw new TerminalError("Hook already exists", {
          errorCode: 409,
        });
      }

      const hookId = ctx.key;
      const now = new Date();

      const result: Hook = {
        runId: "virtual-run", // Virtual objects don't need filesystem-style runId tracking
        hookId,
        token: data.token,
        metadata: data.metadata,
        ownerId: "embedded-owner",
        projectId: "embedded-project",
        environment: "embedded",
        createdAt: now,
      };

      ctx.set("hook", result);

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

      // In a virtual object, we can't really "delete" state,
      // but we can mark it as disposed or return the hook for cleanup
      return hook;
    },

    // Lists are not implemented yet as per instructions
  },
  options: {
    enableLazyState: true,
  },
});
