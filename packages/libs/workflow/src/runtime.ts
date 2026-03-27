import {
  Context,
  createEndpointHandler,
  handlers,
  object,
  ObjectContext,
  ObjectSharedContext,
  RestatePromise,
  service,
  TerminalError,
  serde,
  InvocationIdParser
} from "@restatedev/restate-sdk/fetch";
import { createContext as vmCreateContext, runInContext } from "node:vm";
import { parseStepName, parseWorkflowName } from "./parse-name.js";
import { globalStepRegistry } from "./internal/private.js";
import {
  WORKFLOW_USE_STEP,
  WORKFLOW_CREATE_HOOK,
  WORKFLOW_SLEEP,
  WORKFLOW_CONTEXT,
} from "./symbols.js";
import ms, { type StringValue } from "ms";
import { Hook, HookOptions } from "@workflow/core";

/**
 * Duck-type check for Vercel Workflow's FatalError.
 * Cannot use `instanceof` because the error originates from a VM context
 * with a different prototype chain.
 */
function isFatalError(err: unknown): err is Error & { fatal: true } {
  return (
    typeof err === "object" &&
    err !== null &&
    "message" in err &&
    (("fatal" in err && (err as Record<string, unknown>).fatal === true) ||
      ("name" in err && (err as Record<string, unknown>).name === "FatalError"))
  );
}

/**
 * Errors thrown inside a VM context have a different prototype chain.
 * `instanceof Error` will fail in the host, and `JSON.stringify` returns "{}"
 * because Error properties are non-enumerable.  Convert them to host Errors.
 */
function ensureHostError(err: unknown): unknown {
  if (err instanceof Error) return err;
  if (
    typeof err === "object" &&
    err !== null &&
    "message" in err &&
    typeof (err as Record<string, unknown>).message === "string"
  ) {
    const hostErr = new Error((err as Error).message);
    if ("stack" in err) hostErr.stack = (err as Error).stack;
    if ("name" in err) hostErr.name = (err as Error).name;
    return hostErr;
  }
  return err;
}

/**
 * If the error is a Vercel Workflow FatalError, re-throw as a Restate
 * TerminalError so that Restate stops retrying.
 */
function rethrowFatalAsTerminal(err: unknown): never {
  if (isFatalError(err)) {
    throw new TerminalError(err.message);
  }
  throw err;
}

export function workflowEntrypoint(workflowCode: string) {
  return createEndpointHandler({
    services: [...createServices(workflowCode), hookObj, sleepObj, workflowRunObj],
  });
}

// ---------------------------------------------------------------------------
// workflowRun — virtual object representing a workflow run lifecycle.
// Keyed by Vercel runId. Stores input, starts the workflow, tracks invocation.
// ---------------------------------------------------------------------------

export interface WorkflowRunData {
  runId: string;
  workflowName: string;
  status: "pending" | "running" | "completed" | "failed" | "cancelled";
  output?: unknown;
  error?: string;
  createdAt: number;
  completedAt?: number;
  // Dispatch metadata
  serviceName: string;
  serializedInput: string;
  invocationId?: string;
}

type WorkflowRunState = { data: WorkflowRunData };

export const workflowRunObj = object({
  name: "workflowRun",
  handlers: {
    create: async (
      ctx: ObjectContext<WorkflowRunState>,
      input: { workflowName: string; serviceName: string; input: string }
    ): Promise<WorkflowRunData> => {
      const data: WorkflowRunData = {
        runId: ctx.key,
        workflowName: input.workflowName,
        status: "pending" as const,
        createdAt: await ctx.date.now(),
        serviceName: input.serviceName,
        serializedInput: input.input,
      };
      ctx.set("data", data);
      return data;
    },

    submit: async (
      ctx: ObjectContext<WorkflowRunState>,
      input: { idempotencyKey?: string; delaySeconds?: number }
    ) => {
      const data = await ctx.get("data");
      if (!data) {
        throw new TerminalError(
          `workflowRun/${ctx.key}/submit: missing state — create was not called.`
        );
      }

      // Idempotent: skip if already submitted
      if (data.status !== "pending") return;

      const handle = ctx.genericSend({
        service: data.serviceName,
        method: "run",
        parameter: { serviceName: data.serviceName, payload: data.serializedInput, runId: ctx.key, workflowName: data.workflowName },
        inputSerde: serde.json,
        ...(input.delaySeconds ? { delay: input.delaySeconds * 1000 } : {}),
        ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
      });

      const invocationId = await handle.invocationId;
      const runningData = { ...data, invocationId: invocationId.toString(), status: "running" as const };
      ctx.set("data", runningData);

      // Await workflow completion
      try {
        const output = await ctx.attach(invocationId, serde.json);
        ctx.set("data", {
          ...runningData,
          status: "completed" as const,
          output,
          completedAt: await ctx.date.now(),
        });
      } catch (err) {
        const completedAt = await ctx.date.now();
        if (err instanceof TerminalError && err.code === 409) {
          ctx.set("data", { ...runningData, status: "cancelled" as const, completedAt });
        } else if (err instanceof TerminalError) {
          ctx.set("data", { ...runningData, status: "failed" as const, error: err.message, completedAt });
        } else {
          throw err; // Non-terminal → let Restate retry
        }
      }
    },

    get: handlers.object.shared(
      async (ctx: ObjectSharedContext<WorkflowRunState>) => {
        return await ctx.get("data");
      }
    ),

    // Wait for the workflow invocation to complete and return the final state.
    // Shared so it can run concurrently with the exclusive submit handler.
    awaitResult: handlers.object.shared(
      async (ctx: ObjectSharedContext<WorkflowRunState>) => {
        let data = await ctx.get("data");

        if (!data) {
          throw new TerminalError(`Workflow run ${ctx.key} not found`);
        }

        // Wait for submit to set the invocationId (handles create→submit race)
        while (data.status === "pending") {
          await ctx.sleep(100);
          data = (await ctx.objectClient(workflowRunObj, ctx.key).get()) ?? data;
        }

        if (!data.invocationId) {
          throw new TerminalError(
            `Workflow run ${ctx.key} has status "${data.status}" but no invocationId`
          );
        }

        const invocationId = InvocationIdParser.fromString(data.invocationId);
        return await ctx.attach(invocationId, serde.json);
      }
    ),

    cancel: handlers.object.shared(
      async (ctx: ObjectSharedContext<WorkflowRunState>): Promise<WorkflowRunData | null> => {
        const data = await ctx.get("data");
        if (!data?.invocationId) return data;

        const invocationId = InvocationIdParser.fromString(data.invocationId);
        ctx.cancel(invocationId);

        try {
          await ctx.attach(invocationId, serde.json);
        } catch {
          // Expected: TerminalError for cancelled invocation
        }

        // Poll via the shared get handler until submit has updated the status
        let current = await ctx.objectClient(workflowRunObj, ctx.key).get();
        while (current && current.status === "running") {
          await ctx.sleep(100);
          current = await ctx.objectClient(workflowRunObj, ctx.key).get();
        }
        return current;
      }
    ),
  },
});

export function stepEntrypoint() {}

/**
 * Extract all Restate service names from the bundled workflow code.
 * The bundle contains: __private_workflows.set("workflow//path//FunctionName", ...)
 * There may be multiple workflows in a single bundle.
 */
function extractServiceNames(workflowCode: string): string[] {
  const regex = /__private_workflows\.set\("(workflow\/\/[^"]+)"/g;
  const names: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = regex.exec(workflowCode)) !== null) {
    const workflowId = match[1]!;
    names.push(parseWorkflowName(workflowId)?.shortName ?? workflowId);
  }
  if (names.length === 0) {
    throw new Error(
      "Could not extract workflow name from bundled workflow code"
    );
  }
  return names;
}

function createServices(workflowCode: string) {
  const serviceNames = extractServiceNames(workflowCode);
  return serviceNames.map((serviceName) =>
    service({
      name: serviceName,
      handlers: {
        run: (ctx, {serviceName, payload, runId, workflowName}: {serviceName: string, payload: string, runId: string, workflowName: string}) => restateHandler(ctx, workflowCode, serviceName, payload, runId, workflowName),
      },
    })
  );
}

interface WorkflowOrchestratorContext {
  globalThis: Record<string, unknown>;
  restateCtx: Context;
}

async function restateHandler(
  restateCtx: Context,
  workflowCode: string,
  serviceName: string,
  payload: string,
  runId: string,
  workflowName: string,
) {
  // Wrap the entire handler so that VM errors (which have a different Error
  // prototype and JSON.stringify to "{}") are always converted to host Errors
  // before they propagate to the Restate SDK.
  try {
    const { context, globalThis: vmGlobalThis } = createContext(restateCtx);

    const workflowContext: WorkflowOrchestratorContext = {
      globalThis: vmGlobalThis,
      restateCtx,
    };

    const useStep = createUseStep(workflowContext);
    const createHook = createCreateHook(workflowContext, runId);
    const sleep = createSleep(workflowContext, runId);
    const durableFetch = createDurableFetch(workflowContext);

    // @ts-expect-error - `@types/node` says symbol is not valid, but it does work
    vmGlobalThis[WORKFLOW_USE_STEP] = useStep;
    // @ts-expect-error - `@types/node` says symbol is not valid, but it does work
    vmGlobalThis[WORKFLOW_CREATE_HOOK] = createHook;
    // @ts-expect-error - `@types/node` says symbol is not valid, but it does work
    vmGlobalThis[WORKFLOW_SLEEP] = sleep;

    // Replace the disabled global fetch with the durable version
    vmGlobalThis.fetch = durableFetch;

    // Execute the workflow code to populate globalThis.__private_workflows,
    // then retrieve the first registered workflow function.
    runInContext(workflowCode, context);

    // Set workflow metadata after we know the workflow name.
    // Getters are lazy so they're safe to read after this point.
    const startTime = await restateCtx.date.now();
    // @ts-expect-error - `@types/node` says symbol is not valid, but it does work
    vmGlobalThis[WORKFLOW_CONTEXT] = {
      workflowRunId: runId,
      workflowName: workflowName,
      get workflowStartedAt() {
        return startTime;
      },
      get url(): string {
        const ingress = process.env["RESTATE_INGRESS"];
        if (!ingress) {
          throw new TerminalError(
            "Cannot retrieve workflow submission url. Please set RESTATE_INGRESS env var."
          );
        }
        return `${ingress.replace(/\/+$/, "")}/${serviceName}/run`;
      },
    };

    const workflowsMap = vmGlobalThis.__private_workflows as
      | Map<string, (...args: unknown[]) => unknown>
      | undefined;

    if (!workflowsMap || workflowsMap.size === 0) {
      throw new ReferenceError(
        "No workflows registered. The workflow code did not set globalThis.__private_workflows."
      );
    }

    const workflowFn = workflowsMap.get(workflowName);
    if (typeof workflowFn !== "function") {
      const available = [...workflowsMap.keys()].join(", ");
      throw new ReferenceError(
        `Could not find workflow "${workflowName}" in workflowsMap. Available: ${available}`
      );
    }

    const args: unknown[] = JSON.parse(payload) as unknown[];

    return await workflowFn(...args);
  } catch (err) {
    // VM errors have a different Error prototype, so `instanceof Error` fails
    // in the Restate SDK. Convert them to host Errors to preserve the message.
    rethrowFatalAsTerminal(ensureHostError(err));
  }
}

function createContext(restateCtx: Context) {
  const context = vmCreateContext();

  const g = runInContext("globalThis", context) as Record<string, unknown>;

  // Hook console
  g.console = restateCtx.console;

  // Disable global fetch — workflow code must use the durable fetch injected later
  g.fetch = () => {
    throw new Error(
      'Global "fetch" is unavailable in workflow functions. It will be replaced with a durable version at runtime.'
    );
  };

  // Polyfill Symbol.dispose / Symbol.asyncDispose inside the VM so the
  // compiled `using` keyword works (Node < 20.4 lacks these).
  const vmSymbol = g.Symbol as unknown as Record<string, unknown>;
  if (!vmSymbol["dispose"]) {
    vmSymbol["dispose"] = Symbol.for("Symbol.dispose");
  }
  if (!vmSymbol["asyncDispose"]) {
    vmSymbol["asyncDispose"] = Symbol.for("Symbol.asyncDispose");
  }

  // Expose Web Streams globals needed by bundled library code (e.g. AI SDK's
  // EventSourceParserStream). The upstream builder creates one monolithic bundle
  // for all workflows, so transitive dependencies are unavoidable.
  g.TransformStream = globalThis.TransformStream;
  g.ReadableStream = globalThis.ReadableStream;
  g.WritableStream = globalThis.WritableStream;
  g.TextDecoderStream = globalThis.TextDecoderStream;
  g.Headers = globalThis.Headers;
  g.TextEncoder = globalThis.TextEncoder;
  g.TextDecoder = globalThis.TextDecoder;
  g.console = globalThis.console;
  g.URL = globalThis.URL;
  g.URLSearchParams = globalThis.URLSearchParams;
  g.structuredClone = globalThis.structuredClone;

  // Propagate environment variables
  (g as any).process = {
    env: Object.freeze({ ...process.env }),
  };

  // Stateless + synchronous Web APIs that are made available inside the sandbox
  g.Headers = globalThis.Headers;
  g.TextEncoder = globalThis.TextEncoder;
  g.TextDecoder = globalThis.TextDecoder;
  g.console = globalThis.console;
  g.URL = globalThis.URL;
  g.URLSearchParams = globalThis.URLSearchParams;
  g.structuredClone = globalThis.structuredClone;

  // TC39 Explicit Resource Management polyfill for `using` keyword
  (g.Symbol as any).dispose ??= Symbol.for("Symbol.dispose");
  (g.Symbol as any).asyncDispose ??= Symbol.for("Symbol.asyncDispose");

  return {
    context,
    globalThis: g,
  };
}

type SerializedResponse = {
  __type: "Response";
  status: number;
  statusText: string;
  headers: [string, string][];
  body: string;
  url: string;
};

/**
 * Serialize a native Response into a JSON-safe plain object.
 */
async function serializeResponse(res: Response): Promise<SerializedResponse> {
  return {
    __type: "Response",
    status: res.status,
    statusText: res.statusText,
    headers: [...res.headers.entries()],
    body: await res.text(),
    url: res.url,
  };
}

function isSerializedResponse(v: unknown): v is SerializedResponse {
  return (
    typeof v === "object" &&
    v !== null &&
    (v as Record<string, unknown>).__type === "Response"
  );
}

/**
 * Reconstruct a Response-like object from serialized data.
 *
 * Avoids native `new Response()` because its `headers` getter uses internal
 * slots that break across the host↔VM boundary.  Own data properties on a
 * plain object shadow the getter-only properties on Response.prototype.
 */
function deserializeResponse(serialized: SerializedResponse): Response {
  const bodyText = serialized.body;
  const resp: any = {
    status: serialized.status,
    statusText: serialized.statusText,
    headers: new Headers(serialized.headers),
    ok: serialized.status >= 200 && serialized.status < 300,
    url: serialized.url,
    body: null,
    bodyUsed: false,
    redirected: false,
    type: "basic",
    text: async () => bodyText,
    json: async () => JSON.parse(bodyText),
    arrayBuffer: async () => new TextEncoder().encode(bodyText).buffer,
    blob: async () => new Blob([bodyText]),
    clone: () => deserializeResponse(serialized),
  };
  Object.setPrototypeOf(resp, Response.prototype);
  return resp as Response;
}

function createDurableFetch(ctx: WorkflowOrchestratorContext) {
  return function durableFetch(
    input: string | URL | Request,
    init?: RequestInit
  ): Promise<Response> {
    // Derive a human-readable name for the journal entry
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;

    return ctx.restateCtx
      .run(`fetch ${url}`, async (): Promise<SerializedResponse> => {
        try {
          return await serializeResponse(await fetch(input, init));
        } catch (err) {
          rethrowFatalAsTerminal(err);
        }
      })
      .then(deserializeResponse);
  };
}

function parseSleepDuration(param: number | Date | string): number {
  if (typeof param === "number") {
    return param;
  } else if (
    typeof param === "object" &&
    param !== null &&
    typeof param.getTime === "function"
  ) {
    // Duck-type Date check: VM Date objects have a different prototype
    // than the host Date, so `instanceof Date` fails across contexts.
    return param.getTime() - Date.now();
  } else if (typeof param === "string") {
    const parsed = ms(param as StringValue);
    if (parsed === undefined) {
      throw new Error(
        `Invalid sleep duration string: ${JSON.stringify(param)}`
      );
    }
    return parsed;
  }
  throw new Error(`Invalid sleep parameter: ${JSON.stringify(param)}`);
}

function createSleep(ctx: WorkflowOrchestratorContext, runId: string) {
  return function sleep(param: number | Date | string): Promise<void> {
    const millis = parseSleepDuration(param);
    const correlationId = ctx.restateCtx.rand.uuidv4();
    const { id: awakeableId, promise: wakeUpPromise } = ctx.restateCtx.awakeable();
    const timerPromise = ctx.restateCtx.sleep(millis);

    // Register so wakeUp() can find and resolve this awakeable
    ctx.restateCtx.objectSendClient(sleepObj, runId).register({
      correlationId,
      awakeableId,
    });

    // Race: timer vs external wakeUp
    const raced = RestatePromise.race([timerPromise, wakeUpPromise]);

    return (raced as Promise<unknown>).then(() => {
      // Clean up the registration
      ctx.restateCtx.objectSendClient(sleepObj, runId).complete({
        correlationId,
      });
    });
  };
}

function createUseStep(ctx: WorkflowOrchestratorContext) {
  return function useStep<Args extends unknown[], Result>(stepName: string) {
    const stepFunction = (...args: Args): Promise<Result> => {
      const stepFn = globalStepRegistry.get(stepName);
      if (stepFn === undefined) {
        throw new Error(
          `Can't find ${stepName} in the global registry. Available steps: ${[...globalStepRegistry.keys()].join(", ")}`
        );
      }

      return ctx.restateCtx.run(
        parseStepName(stepName)?.shortName ?? stepName,
        async () => {
          try {
            const result = await (stepFn(...args) as Promise<Result>);
            // Native Response objects JSON-serialize to "{}" because their
            // properties are non-enumerable getters.  Convert to a plain
            // serializable form so Restate can journal it.
            if (result instanceof Response) {
              return await serializeResponse(result) as unknown as Result;
            }
            return result;
          } catch (err) {
            rethrowFatalAsTerminal(err);
          }
        }
      ).then((result: Result) => {
        // Reconstruct the Response on the way back into the VM.
        if (isSerializedResponse(result)) {
          return deserializeResponse(result) as unknown as Result;
        }
        return result;
      });
    };

    // Ensure the "name" property matches the original step function name
    // Extract function name from stepName (format: "step//filepath//functionName")
    const functionName = stepName.split("//").pop();
    Object.defineProperty(stepFunction, "name", {
      value: functionName,
    });

    // Add the step function identifier to the step function for serialization
    Object.defineProperty(stepFunction, "stepId", {
      value: stepName,
      writable: false,
      enumerable: false,
      configurable: false,
    });

    return stepFunction;
  };
}

/**
 * Serialized representation of a Request object for webhook hooks.
 * Used to pass Request data through Restate's JSON-based awakeables.
 */
type SerializedRequest = {
  method: string;
  url: string;
  headers: [string, string][];
  body: string | null;
};

/**
 * Reconstruct a Request object from its serialized form.
 * Used inside the workflow VM to give webhook hooks a proper Request.
 */
function deserializeRequest(data: SerializedRequest): Request {
  return new Request(data.url, {
    method: data.method,
    headers: new Headers(data.headers),
    body: data.body,
  });
}

export function createCreateHook(ctx: WorkflowOrchestratorContext, runId: string) {
  return function createHookImpl<T = unknown>(
    options: HookOptions = {}
  ): Hook<T> {
    const { id, promise } = ctx.restateCtx.awakeable();
    const token = options.token ?? id;
    const isWebhook = options.isWebhook ?? false;

    // Register hook
    ctx.restateCtx.objectSendClient(hookObj, token).create({
      awakeableId: id,
      runId,
      invocationId: ctx.restateCtx.request().id,
      isWebhook,
      metadata: options.metadata,
    });

    // For webhook hooks, reconstruct Request from serialized data
    const resolvedPromise = isWebhook
      ? promise.then((data) => deserializeRequest(data as SerializedRequest) as T)
      : (promise as Promise<T>);

    const hook: Hook<T> = {
      token,

      // biome-ignore lint/suspicious/noThenProperty: Intentionally thenable
      then<TResult1 = T, TResult2 = never>(
        onfulfilled?: ((value: T) => TResult1 | PromiseLike<TResult1>) | null,
        onrejected?:
          | ((reason: unknown) => TResult2 | PromiseLike<TResult2>)
          | null
      ): Promise<TResult1 | TResult2> {
        return resolvedPromise.then(onfulfilled, onrejected);
      },

      dispose() {
        ctx.restateCtx.objectSendClient(hookObj, token).dispose();
      },

      [Symbol.dispose]() {
        this.dispose();
      },

      // Support `for await (const payload of hook) { … }` syntax
      async *[Symbol.asyncIterator]() {
        while (true) {
          yield await this;
        }
      },
    };

    // Also register with the VM's Symbol.dispose if it differs from the host's.
    // vm.createContext() has its own Symbol constructor where dispose may be
    // polyfilled to a different value than the host's native Symbol.dispose.
    const vmDispose = (ctx.globalThis.Symbol as Record<string, unknown>)?.dispose as symbol | undefined;
    if (vmDispose && vmDispose !== Symbol.dispose) {
      (hook as unknown as Record<symbol, unknown>)[vmDispose] = () => hook.dispose();
    }

    return hook;
  };
}

// ---------------------------------------------------------------------------
// workflowSleep — virtual object tracking pending sleeps for a workflow run.
// Keyed by runId. Each sleep registers an awakeable that wakeUp() can resolve.
// ---------------------------------------------------------------------------

type SleepEntry = {
  correlationId: string;
  awakeableId: string;
};

type SleepState = {
  pending: SleepEntry[];
};

export const sleepObj = object({
  name: "workflowSleep",
  handlers: {
    register: async (
      ctx: ObjectContext<SleepState>,
      input: SleepEntry
    ) => {
      const pending = (await ctx.get("pending")) ?? [];
      pending.push(input);
      ctx.set("pending", pending);
    },

    complete: async (
      ctx: ObjectContext<SleepState>,
      input: { correlationId: string }
    ) => {
      const pending = (await ctx.get("pending")) ?? [];
      ctx.set("pending", pending.filter(e => e.correlationId !== input.correlationId));
    },

    wakeUp: async (
      ctx: ObjectContext<SleepState>,
      input: { correlationId: string }
    ) => {
      const pending = (await ctx.get("pending")) ?? [];
      const entry = pending.find(e => e.correlationId === input.correlationId);
      if (!entry) return;
      ctx.resolveAwakeable(entry.awakeableId, undefined);
      ctx.set("pending", pending.filter(e => e.correlationId !== input.correlationId));
    },

    getPending: handlers.object.shared(
      async (ctx: ObjectSharedContext<SleepState>): Promise<SleepEntry[]> => {
        return (await ctx.get("pending")) ?? [];
      }
    ),
  },
});

// ---------------------------------------------------------------------------
// workflowHooks — virtual object for hook lifecycle. Keyed by hook token.
// ---------------------------------------------------------------------------

type HooksState = {
  awakeableId: string;
  runId: string;
  createdAt: number;
  invocationId: string;
  isWebhook: boolean;
  metadata: unknown;
};

export const hookObj = object({
  name: "workflowHooks",
  handlers: {
    create: async (
      ctx: ObjectContext<HooksState>,
      input: { awakeableId: string; runId: string; invocationId: string; isWebhook?: boolean; metadata?: unknown }
    ) => {
      // Reject duplicate token while a previous hook is still active
      if ((await ctx.get("awakeableId")) !== null) {
        throw new TerminalError("Hook already exists", { errorCode: 409 });
      }

      ctx.set("awakeableId", input.awakeableId);
      ctx.set("runId", input.runId);
      ctx.set("invocationId", input.invocationId);
      ctx.set("createdAt", await ctx.date.now());
      ctx.set("isWebhook", input.isWebhook ?? false);
      ctx.set("metadata", input.metadata ?? null);
    },
    resolve: async (
      ctx: ObjectContext<HooksState>,
      input: unknown
    ): Promise<{ invocationId: string }> => {
      const awakeableId = await ctx.get("awakeableId");
      if (!awakeableId) {
        throw new TerminalError("No awakeableId found");
      }
      ctx.resolveAwakeable(awakeableId, input);
      ctx.clear("awakeableId");
      return { invocationId: (await ctx.get("invocationId"))! };
    },
    get: handlers.object.shared(
      async (ctx: ObjectSharedContext<HooksState>) => {
        const runId = await ctx.get("runId");
        if (runId === null) return null;
        return {
          runId,
          hookId: ctx.key,
          token: ctx.key,
          ownerId: "restate",
          projectId: "restate",
          environment: "development",
          createdAt: (await ctx.get("createdAt")) ?? 0,
          isWebhook: (await ctx.get("isWebhook")) ?? false,
          metadata: (await ctx.get("metadata")) ?? undefined,
        };
      }
    ),
    // eslint-disable-next-line @typescript-eslint/require-await
    dispose: async (ctx: ObjectContext) => {
      ctx.clearAll();
    },
  },
});

// ---------------------------------------------------------------------------
// World management — exports expected by the upstream `workflow/runtime` module.
// When the upstream workbench app's instrumentation.ts does:
//   import('workflow/runtime').then(({ getWorld }) => getWorld().start?.())
// and the Turbopack alias points `workflow/runtime` → `@restatedev/workflow/runtime`,
// these exports satisfy that contract.
// ---------------------------------------------------------------------------

import { createWorld as _createWorld } from "./world.js";
import type { World } from "@workflow/world";

const WorldCache = Symbol.for("@workflow/world//cache");
const globalSymbols = globalThis as unknown as Record<symbol, World | undefined>;

export { _createWorld as createWorld };

export function getWorld(): World {
  if (globalSymbols[WorldCache]) return globalSymbols[WorldCache]!;
  globalSymbols[WorldCache] = _createWorld();
  return globalSymbols[WorldCache]!;
}

export function setWorld(world: World | undefined): void {
  globalSymbols[WorldCache] = world;
}

export function getWorldHandlers(): Pick<World, "createQueueHandler"> {
  const w = getWorld();
  return { createQueueHandler: w.createQueueHandler };
}

export function healthCheck(): Promise<{ ok: boolean }> {
  // No-op for Restate — the Restate server handles health checks natively.
  return Promise.resolve({ ok: true });
}
