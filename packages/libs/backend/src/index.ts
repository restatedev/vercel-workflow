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
} from "@workflow/world";
import { DEFAULT_RESOLVE_DATA_OPTION, filterRunData } from "./utils.js";

// key by runId

export type WorkflowContext = ObjectContext<{ run: WorkflowRun }>;

export const workflowApi = object({
  name: "workflow",
  handlers: {
    async create(ctx: WorkflowContext, data: CreateWorkflowRunRequest) {
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

    async get(ctx: WorkflowContext, params?: GetWorkflowRunParams) {
      const run = await ctx.get("run");
      if (!run) {
        throw new TerminalError("Workflow run not found", { errorCode: 404 });
      }
      const resolveData = params?.resolveData ?? DEFAULT_RESOLVE_DATA_OPTION;
      return filterRunData(run, resolveData);
    },

    async update(ctx: WorkflowContext, data: UpdateWorkflowRunRequest) {
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

    async list(
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

    async cancel(ctx: WorkflowContext, params?: CancelWorkflowRunParams) {
      const run = await this.update(ctx, { status: "cancelled" });
      const resolveData = params?.resolveData ?? DEFAULT_RESOLVE_DATA_OPTION;
      return filterRunData(run, resolveData);
    },

    async pause(ctx: WorkflowContext, params?: PauseWorkflowRunParams) {
      const run = await this.update(ctx, { status: "paused" });
      const resolveData = params?.resolveData ?? DEFAULT_RESOLVE_DATA_OPTION;
      return filterRunData(run, resolveData);
    },

    async resume(ctx: WorkflowContext, params?: ResumeWorkflowRunParams) {
      const run = await this.update(ctx, { status: "running" });
      const resolveData = params?.resolveData ?? DEFAULT_RESOLVE_DATA_OPTION;
      return filterRunData(run, resolveData);
    },
  },
  options: {
    enableLazyState: true,
  },
});
