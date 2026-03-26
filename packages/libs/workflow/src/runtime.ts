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

    // Shared handler so it can run concurrently with the exclusive submit handler
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

  // Invoke user workflow
  try {
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

  // HACK: Shim `exports` for the bundle
  // TODO(slinkydeveloper) seems important, need to figure out why
  g.exports = {};
  g.module = { exports: g.exports };

  return {
    context,
    globalThis: g,
  };
}

type SerializedResponse = {
  status: number;
  statusText: string;
  headers: [string, string][];
  body: string;
  url: string;
};

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
          const res = await fetch(input, init);
          const body = await res.text();
          return {
            status: res.status,
            statusText: res.statusText,
            headers: [...res.headers.entries()],
            body,
            url: res.url,
          };
        } catch (err) {
          rethrowFatalAsTerminal(err);
        }
      })
      .then((serialized: SerializedResponse) => {
        return new Response(serialized.body, {
          status: serialized.status,
          statusText: serialized.statusText,
          headers: new Headers(serialized.headers),
        });
      });
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
            return await (stepFn(...args) as Promise<Result>);
          } catch (err) {
            rethrowFatalAsTerminal(err);
          }
        }
      );
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

export function createCreateHook(ctx: WorkflowOrchestratorContext, runId: string) {
  return function createHookImpl<T = unknown>(
    options: HookOptions = {}
  ): Hook<T> {
    const { id, promise } = ctx.restateCtx.awakeable();
    const token = options.token ?? id;

    // Register hook
    ctx.restateCtx.objectSendClient(hookObj, token).create({
      awakeableId: id,
      runId,
      invocationId: ctx.restateCtx.request().id,
    });

    const hook: Hook<T> = {
      token,

      // biome-ignore lint/suspicious/noThenProperty: Intentionally thenable
      then<TResult1 = T, TResult2 = never>(
        onfulfilled?: ((value: T) => TResult1 | PromiseLike<TResult1>) | null,
        onrejected?:
          | ((reason: unknown) => TResult2 | PromiseLike<TResult2>)
          | null
      ): Promise<TResult1 | TResult2> {
        return (promise as Promise<T>).then(onfulfilled, onrejected);
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
};

export const hookObj = object({
  name: "workflowHooks",
  handlers: {
    create: async (
      ctx: ObjectContext<HooksState>,
      input: { awakeableId: string; runId: string; invocationId: string }
    ) => {
      // Reject duplicate token while a previous hook is still active
      if ((await ctx.get("awakeableId")) !== null) {
        throw new TerminalError("Hook already exists", { errorCode: 409 });
      }

      ctx.set("awakeableId", input.awakeableId);
      ctx.set("runId", input.runId);
      ctx.set("invocationId", input.invocationId);
      ctx.set("createdAt", await ctx.date.now());
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
        };
      }
    ),
    // eslint-disable-next-line @typescript-eslint/require-await
    dispose: async (ctx: ObjectContext) => {
      ctx.clearAll();
    },
  },
});
