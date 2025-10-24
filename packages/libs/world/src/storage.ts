import { Ingress, rpc } from "@restatedev/restate-sdk-clients";

import {
  EventSchema,
  HookSchema,
  StepSchema,
  WorkflowRunSchema,
  type CancelWorkflowRunParams,
  type CreateEventParams,
  type CreateEventRequest,
  type CreateHookRequest,
  type CreateStepRequest,
  type CreateWorkflowRunRequest,
  type Event,
  type GetHookParams,
  type GetStepParams,
  type GetWorkflowRunParams,
  type Hook,
  type ListEventsByCorrelationIdParams,
  type ListEventsParams,
  type ListHooksParams,
  type ListWorkflowRunsParams,
  type ListWorkflowRunStepsParams,
  type PaginatedResponse,
  type PauseWorkflowRunParams,
  type ResumeWorkflowRunParams,
  type Step,
  type Storage,
  type UpdateStepRequest,
  type UpdateWorkflowRunRequest,
  type WorkflowRun,
} from "@workflow/world";

import type { IndexService, WorkflowApi, HooksApi } from "@restatedev/backend";
import { serde } from "@restatedev/common";

const createStorage = (client: Ingress): Storage => {
  return {
    runs: {
      create: async function (
        data: CreateWorkflowRunRequest
      ): Promise<WorkflowRun> {
        const runId = `wfrun_${Math.random().toString(36).substring(2, 16)}`;

        const res = await client
          .objectClient<WorkflowApi>({ name: "workflow" }, runId)
          .createRun(data, rpc.opts({ output: serde.zod(WorkflowRunSchema) }));

        return res;
      },

      get: async function (
        id: string,
        params?: GetWorkflowRunParams
      ): Promise<WorkflowRun> {
        const res = await client
          .objectClient<WorkflowApi>({ name: "workflow" }, id)
          .getRun(params, rpc.opts({ output: serde.zod(WorkflowRunSchema) }));
        return res;
      },

      update: async function (
        id: string,
        data: UpdateWorkflowRunRequest
      ): Promise<WorkflowRun> {
        const res = await client
          .objectClient<WorkflowApi>({ name: "workflow" }, id)
          .updateRun(data, rpc.opts({ output: serde.zod(WorkflowRunSchema) }));

        return res;
      },

      list: async function (
        params?: ListWorkflowRunsParams
      ): Promise<PaginatedResponse<WorkflowRun>> {
        const res = await client
          .serviceClient<IndexService>({ name: "indexService" })
          .listRun(
            { params },
            rpc.opts({ output: serde.zod(WorkflowRunSchema.array()) })
          );

        return {
          data: res,
          hasMore: false,
          cursor: null,
        };
      },

      cancel: async function (
        id: string,
        params?: CancelWorkflowRunParams
      ): Promise<WorkflowRun> {
        const res = await client
          .objectClient<WorkflowApi>({ name: "workflow" }, id)
          .cancelRun(
            params,
            rpc.opts({ output: serde.zod(WorkflowRunSchema) })
          );
        return res;
      },
      pause: async function (
        id: string,
        params?: PauseWorkflowRunParams
      ): Promise<WorkflowRun> {
        const res = await client
          .objectClient<WorkflowApi>({ name: "workflow" }, id)
          .pauseRun(params, rpc.opts({ output: serde.zod(WorkflowRunSchema) }));
        return res;
      },
      resume: async function (
        id: string,
        params?: ResumeWorkflowRunParams
      ): Promise<WorkflowRun> {
        const res = await client
          .objectClient<WorkflowApi>({ name: "workflow" }, id)
          .resumeRun(
            params,
            rpc.opts({ output: serde.zod(WorkflowRunSchema) })
          );
        return res;
      },
    },
    steps: {
      create: async function (
        runId: string,
        data: CreateStepRequest
      ): Promise<Step> {
        const res = await client
          .objectClient<WorkflowApi>({ name: "workflow" }, runId)
          .createStep(data, rpc.opts({ output: serde.zod(StepSchema) }));
        return res;
      },
      get: async function (
        runId: string | undefined,
        stepId: string,
        params?: GetStepParams
      ): Promise<Step> {
        if (!runId) {
          throw new Error("runId is required");
        }
        const res = await client
          .objectClient<WorkflowApi>({ name: "workflow" }, runId)
          .getStep(
            { stepId, ...params },
            rpc.opts({ output: serde.zod(StepSchema) })
          );
        return res;
      },
      update: async function (
        runId: string,
        stepId: string,
        data: UpdateStepRequest
      ): Promise<Step> {
        const res = await client
          .objectClient<WorkflowApi>({ name: "workflow" }, runId)
          .updateStep(
            { stepId, ...data },
            rpc.opts({ output: serde.zod(StepSchema) })
          );
        return res;
      },
      list: async function (
        params: ListWorkflowRunStepsParams
      ): Promise<PaginatedResponse<Step>> {
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
      },
    },
    events: {
      create: async function (
        runId: string,
        data: CreateEventRequest,
        params?: CreateEventParams
      ): Promise<Event> {
        const res = await client
          .objectClient<WorkflowApi>({ name: "workflow" }, runId)
          .createEvent(
            { ...data, ...params },
            rpc.opts({ output: serde.zod(EventSchema) })
          );
        return res;
      },

      list: async function (
        params: ListEventsParams
      ): Promise<PaginatedResponse<Event>> {
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
      },
      listByCorrelationId: async function (
        params: ListEventsByCorrelationIdParams
      ): Promise<PaginatedResponse<Event>> {
        const res = await client
          .serviceClient<IndexService>({ name: "indexService" })
          .getEventsByCorrelationId(
            params,
            rpc.opts({ output: serde.zod(EventSchema.array()) })
          );

        return {
          data: res,
          hasMore: false,
          cursor: null,
        };
      },
    },
    hooks: {
      create: async function (
        runId: string,
        data: CreateHookRequest,
        params?: GetHookParams
      ): Promise<Hook> {
        const res = await client
          .objectClient<HooksApi>({ name: "hooks" }, data.hookId)
          .create(
            { ...data, ...params, runId },
            rpc.opts({ output: serde.zod(HookSchema) })
          );

        return res;
      },

      get: async function (
        hookId: string,
        params?: GetHookParams
      ): Promise<Hook> {
        const res = await client
          .objectClient<HooksApi>({ name: "hooks" }, hookId)
          .get(params, rpc.opts({ output: serde.zod(HookSchema) }));

        return res;
      },
      getByToken: async function (
        token: string,
        params?: GetHookParams
      ): Promise<Hook> {
        const res = await client
          .serviceClient<IndexService>({ name: "indexService" })
          .getHookByToken(
            { ...params, token },
            rpc.opts({ output: serde.zod(HookSchema) })
          );
        return res;
      },

      list: async function (
        params: ListHooksParams
      ): Promise<PaginatedResponse<Hook>> {
        // TODO: Implement list hooks in the backend service
        throw new Error("List hooks not implemented in backend service yet");
      },

      dispose: async function (
        hookId: string,
        params?: GetHookParams
      ): Promise<Hook> {
        const res = await client
          .objectClient<HooksApi>({ name: "hooks" }, hookId)
          .dispose(rpc.opts({ output: serde.zod(HookSchema) }));
        return res;
      },
    },
  };
};

export { createStorage };
