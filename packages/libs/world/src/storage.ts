import { connect, Ingress } from "@restatedev/restate-sdk-clients";

import type {
  CancelWorkflowRunParams,
  CreateEventParams,
  CreateEventRequest,
  CreateHookRequest,
  CreateStepRequest,
  CreateWorkflowRunRequest,
  Event,
  GetHookParams,
  GetStepParams,
  GetWorkflowRunParams,
  Hook,
  ListEventsByCorrelationIdParams,
  ListEventsParams,
  ListHooksParams,
  ListWorkflowRunsParams,
  ListWorkflowRunStepsParams,
  PaginatedResponse,
  PauseWorkflowRunParams,
  ResumeWorkflowRunParams,
  Step,
  Storage,
  UpdateStepRequest,
  UpdateWorkflowRunRequest,
  WorkflowRun,
} from "@workflow/world";

import type { IndexService, WorkflowApi, HooksApi } from "@restatedev/backend";

const createStorage = (client: Ingress): Storage => {
  return {
    runs: {
      create: async function (
        data: CreateWorkflowRunRequest
      ): Promise<WorkflowRun> {
        const runId = `wfrun_${Math.random().toString(36).substring(2, 16)}`;

        const res = await client
          .objectClient<WorkflowApi>({ name: "workflow" }, runId)
          .createRun(data);

        return res;
      },

      get: async function (
        id: string,
        params?: GetWorkflowRunParams
      ): Promise<WorkflowRun> {
        const res = await client
          .objectClient<WorkflowApi>({ name: "workflow" }, id)
          .getRun(params);
        return res;
      },
      update: async function (
        id: string,
        data: UpdateWorkflowRunRequest
      ): Promise<WorkflowRun> {
        const res = await client
          .objectClient<WorkflowApi>({ name: "workflow" }, id)
          .updateRun(data);

        return res;
      },

      list: async function (
        params?: ListWorkflowRunsParams
      ): Promise<PaginatedResponse<WorkflowRun>> {
        const res = await client
          .serviceClient<IndexService>({ name: "indexService" })
          .listRun(params);

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
          .cancelRun(params);
        return res;
      },
      pause: async function (
        id: string,
        params?: PauseWorkflowRunParams
      ): Promise<WorkflowRun> {
        const res = await client
          .objectClient<WorkflowApi>({ name: "workflow" }, id)
          .pauseRun(params);
        return res;
      },
      resume: async function (
        id: string,
        params?: ResumeWorkflowRunParams
      ): Promise<WorkflowRun> {
        const res = await client
          .objectClient<WorkflowApi>({ name: "workflow" }, id)
          .resumeRun(params);
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
          .createStep(data);
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
          .getStep({ stepId, ...params });
        return res;
      },
      update: async function (
        runId: string,
        stepId: string,
        data: UpdateStepRequest
      ): Promise<Step> {
        const res = await client
          .objectClient<WorkflowApi>({ name: "workflow" }, runId)
          .updateStep({ stepId, ...data });
        return res;
      },
      list: async function (
        params: ListWorkflowRunStepsParams
      ): Promise<PaginatedResponse<Step>> {
        const res = await client
          .objectClient<WorkflowApi>({ name: "workflow" }, params.runId)
          .listSteps(params);

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
          .createEvent({ ...data, ...params });
        return res;
      },

      list: async function (
        params: ListEventsParams
      ): Promise<PaginatedResponse<Event>> {
        const res = await client
          .objectClient<WorkflowApi>({ name: "workflow" }, params.runId)
          .listEvents(params);

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
          .getEventsByCorrelationId(params);

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
          .create({ ...data, ...params, runId });

        return res;
      },

      get: async function (
        hookId: string,
        params?: GetHookParams
      ): Promise<Hook> {
        const res = await client
          .objectClient<HooksApi>({ name: "hooks" }, hookId)
          .get(params);
        return res;
      },
      getByToken: async function (
        token: string,
        params?: GetHookParams
      ): Promise<Hook> {
        const res = await client
          .serviceClient<IndexService>({ name: "indexService" })
          .getHookByToken({ ...params, token });
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
          .dispose();
        return res;
      },
    },
  };
};

export { createStorage };
