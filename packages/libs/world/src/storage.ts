import { Ingress, rpc, HttpCallError } from "@restatedev/restate-sdk-clients";

import {
  type CancelWorkflowRunParams,
  type CreateEventParams,
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
  type ListEventsByCorrelationIdParams,
  type ListEventsParams,
  type ListHooksParams,
  type ListWorkflowRunsParams,
  type ListWorkflowRunStepsParams,
  type PaginatedResponse,
  type PauseWorkflowRunParams,
  type ResumeWorkflowRunParams,
  type Step,
  StepSchema,
  type Storage,
  type UpdateStepRequest,
  type UpdateWorkflowRunRequest,
  type WorkflowRun,
  WorkflowRunSchema,
} from "@workflow/world";

import type { IndexApi, WorkflowApi } from "@restatedev/backend";
import { serde } from "@restatedev/restate-sdk-zod";
import { WorkflowAPIError, WorkflowRunNotFoundError } from "@workflow/errors";

function throwVercelError(e: any, runId?: string): never {
  if (e instanceof HttpCallError) {
    if (runId && e.status == 404) {
      throw new WorkflowRunNotFoundError(runId);
    }
    throw new WorkflowAPIError(e.message, { status: e.status, cause: e.cause });
  }
  throw e;
}

const createStorage = (client: Ingress): Storage => {
  return {
    runs: {
      create: async function (
        data: CreateWorkflowRunRequest
      ): Promise<WorkflowRun> {
        const runId = `wfrun_${Math.random().toString(36).substring(2, 16)}`;

        try {
          return await client
            .objectClient<WorkflowApi>({ name: "workflow" }, runId)
            .createRun(
              data,
              rpc.opts({ output: serde.zod(WorkflowRunSchema) })
            );
        } catch (e) {
          throwVercelError(e);
        }
      },

      get: async function (
        id: string,
        params?: GetWorkflowRunParams
      ): Promise<WorkflowRun> {
        try {
          return await client
            .objectClient<WorkflowApi>({ name: "workflow" }, id)
            .getRun(
              params ?? {},
              rpc.opts({ output: serde.zod(WorkflowRunSchema) })
            );
        } catch (e) {
          throwVercelError(e, id);
        }
      },

      update: async function (
        id: string,
        data: UpdateWorkflowRunRequest
      ): Promise<WorkflowRun> {
        try {
          return await client
            .objectClient<WorkflowApi>({ name: "workflow" }, id)
            .updateRun(
              data,
              rpc.opts({ output: serde.zod(WorkflowRunSchema) })
            );
        } catch (e) {
          throwVercelError(e, id);
        }
      },

      list: async function (
        params?: ListWorkflowRunsParams
      ): Promise<PaginatedResponse<WorkflowRun>> {
        try {
          const res = await client
            .serviceClient<IndexApi>({ name: "index" })
            .listRun(
              params ?? {},
              rpc.opts({ output: serde.zod(WorkflowRunSchema.array()) })
            );

          return {
            data: res,
            hasMore: false,
            cursor: null,
          };
        } catch (e) {
          throwVercelError(e);
        }
      },

      cancel: async function (
        id: string,
        params?: CancelWorkflowRunParams
      ): Promise<WorkflowRun> {
        try {
          return await client
            .objectClient<WorkflowApi>({ name: "workflow" }, id)
            .cancelRun(
              params ?? {},
              rpc.opts({ output: serde.zod(WorkflowRunSchema) })
            );
        } catch (e) {
          throwVercelError(e, id);
        }
      },

      pause: async function (
        id: string,
        params?: PauseWorkflowRunParams
      ): Promise<WorkflowRun> {
        try {
          return await client
            .objectClient<WorkflowApi>({ name: "workflow" }, id)
            .pauseRun(
              params ?? {},
              rpc.opts({ output: serde.zod(WorkflowRunSchema) })
            );
        } catch (e) {
          throwVercelError(e, id);
        }
      },

      resume: async function (
        id: string,
        params?: ResumeWorkflowRunParams
      ): Promise<WorkflowRun> {
        try {
          return await client
            .objectClient<WorkflowApi>({ name: "workflow" }, id)
            .resumeRun(
              params ?? {},
              rpc.opts({ output: serde.zod(WorkflowRunSchema) })
            );
        } catch (e) {
          throwVercelError(e, id);
        }
      },
    },

    steps: {
      create: async function (
        runId: string,
        data: CreateStepRequest
      ): Promise<Step> {
        try {
          return await client
            .objectClient<WorkflowApi>({ name: "workflow" }, runId)
            .createStep(data, rpc.opts({ output: serde.zod(StepSchema) }));
        } catch (e) {
          throwVercelError(e, runId);
        }
      },

      get: async function (
        runId: string | undefined,
        stepId: string,
        params?: GetStepParams
      ): Promise<Step> {
        if (!runId) {
          throw new Error("runId is required");
        }
        try {
          return await client
            .objectClient<WorkflowApi>({ name: "workflow" }, runId)
            .getStep(
              { stepId, ...params },
              rpc.opts({ output: serde.zod(StepSchema) })
            );
        } catch (e) {
          throwVercelError(e, runId);
        }
      },

      update: async function (
        runId: string,
        stepId: string,
        data: UpdateStepRequest
      ): Promise<Step> {
        try {
          return await client
            .objectClient<WorkflowApi>({ name: "workflow" }, runId)
            .updateStep(
              { stepId, ...data },
              rpc.opts({ output: serde.zod(StepSchema) })
            );
        } catch (e) {
          throwVercelError(e, runId);
        }
      },

      list: async function (
        params: ListWorkflowRunStepsParams
      ): Promise<PaginatedResponse<Step>> {
        try {
          const res = await client
            .objectClient<WorkflowApi>({ name: "workflow" }, params.runId)
            .listSteps(
              params,
              rpc.opts({ output: serde.zod(StepSchema.array()) })
            );

          return {
            data: res,
            hasMore: false,
            cursor: null,
          };
        } catch (e) {
          throwVercelError(e);
        }
      },
    },

    events: {
      create: async function (
        runId: string,
        data: CreateEventRequest,
        params?: CreateEventParams
      ): Promise<Event> {
        try {
          return await client
            .objectClient<WorkflowApi>({ name: "workflow" }, runId)
            .createEvent(
              { ...data, ...params },
              rpc.opts({ output: serde.zod(EventSchema) })
            );
        } catch (e) {
          throwVercelError(e, runId);
        }
      },

      list: async function (
        params: ListEventsParams
      ): Promise<PaginatedResponse<Event>> {
        try {
          const res = await client
            .objectClient<WorkflowApi>({ name: "workflow" }, params.runId)
            .listEvents(
              params,
              rpc.opts({ output: serde.zod(EventSchema.array()) })
            );

          return {
            data: res,
            hasMore: false,
            cursor: null,
          };
        } catch (e) {
          throwVercelError(e, params.runId);
        }
      },

      listByCorrelationId: async function (
        params: ListEventsByCorrelationIdParams
      ): Promise<PaginatedResponse<Event>> {
        try {
          const res = await client
            .serviceClient<IndexApi>({ name: "index" })
            .getEventsByCorrelationId(
              params,
              rpc.opts({ output: serde.zod(EventSchema.array()) })
            );

          return {
            data: res,
            hasMore: false,
            cursor: null,
          };
        } catch (e) {
          throwVercelError(e);
        }
      },
    },

    hooks: {
      create: async function (
        runId: string,
        data: CreateHookRequest,
        params?: GetHookParams
      ): Promise<Hook> {
        try {
          return await client
            .objectClient<WorkflowApi>({ name: "workflow" }, runId)
            .createHook(
              { ...data, ...params },
              rpc.opts({ output: serde.zod(HookSchema) })
            );
        } catch (e) {
          throwVercelError(e, runId);
        }
      },

      get: async function (
        hookId: string,
        params?: GetHookParams
      ): Promise<Hook> {
        try {
          return await client
            .serviceClient<IndexApi>({ name: "index" })
            .getHookById(
              {
                ...params,
                hookId,
              },
              rpc.opts({ output: serde.zod(HookSchema) })
            );
        } catch (e) {
          throwVercelError(e);
        }
      },

      getByToken: async function (
        token: string,
        params?: GetHookParams
      ): Promise<Hook> {
        try {
          return await client
            .serviceClient<IndexApi>({ name: "index" })
            .getHookByToken(
              {
                ...params,
                token,
              },
              rpc.opts({ output: serde.zod(HookSchema) })
            );
        } catch (e) {
          throwVercelError(e);
        }
      },

      list: async function (
        params: ListHooksParams
      ): Promise<PaginatedResponse<Hook>> {
        if (!params.runId) {
          throw new WorkflowAPIError("Unsupported list hooks without runId", {
            status: 501,
          });
        }
        try {
          const res = await client
            .objectClient<WorkflowApi>({ name: "workflow" }, params.runId)
            .listHooks(
              {
                pagination: params.pagination,
                resolveData: params.resolveData,
              },
              rpc.opts({ output: serde.zod(HookSchema.array()) })
            );

          return {
            data: res,
            hasMore: false,
            cursor: null,
          };
        } catch (e) {
          throwVercelError(e);
        }
      },

      dispose: async function (
        hookId: string,
        params?: GetHookParams
      ): Promise<Hook> {
        try {
          const hook = await client
            .serviceClient<IndexApi>({ name: "index" })
            .getHookById(
              {
                hookId,
                resolveData: "none",
              },
              rpc.opts({ output: serde.zod(HookSchema) })
            );

          await client
            .objectClient<WorkflowApi>({ name: "workflow" }, hook.runId)
            .disposeHook(
              {
                hookId: hookId,
                resolveData: params?.resolveData,
              },
              rpc.opts({ output: serde.zod(HookSchema) })
            );

          return hook;
        } catch (e) {
          throwVercelError(e);
        }
      },
    },
  };
};

export { createStorage };
