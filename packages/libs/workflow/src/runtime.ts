import {
  Context,
  createEndpointHandler,
  handlers,
  internal,
  object,
  ObjectContext,
  ObjectSharedContext,
  RestatePromise,
  RetryableError as RestateRetryableError,
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
 * Duck-type check for Vercel Workflow's RetryableError. Same VM-prototype
 * caveat as isFatalError. Vercel exposes `retryAfter: Date` (absolute time);
 * the caller maps that to Restate's `delay` (duration from now).
 */
function isVercelRetryableError(
  err: unknown
): err is Error & { retryAfter: Date } {
  return (
    typeof err === "object" &&
    err !== null &&
    "name" in err &&
    (err as Record<string, unknown>).name === "RetryableError" &&
    "retryAfter" in err &&
    (err as { retryAfter: unknown }).retryAfter instanceof Date
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
 * A TerminalError subclass that also identifies itself as Vercel's FatalError.
 *
 * - Extends TerminalError so Restate stops retrying the invocation.
 * - Sets `name = "FatalError"` and `fatal = true` so workflow code that does
 *   `FatalError.is(e)` (which checks `e.name === "FatalError"`) sees a match.
 *   The name property survives the host→VM error crossing (the prototype
 *   chain doesn't, but `instanceof` isn't what FatalError.is uses).
 */
export class FatalTerminalError extends TerminalError {
  fatal = true;
  constructor(message: string) {
    super(message);
    this.name = "FatalError";
  }
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

function getIngressUrl(): string {
  const ingress = process.env["RESTATE_INGRESS"];
  if (!ingress) {
    throw new TerminalError("Please set the RESTATE_INGRESS env var.");
  }
  return ingress.replace(/\/+$/, "");
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

type SubmitOpts = { idempotencyKey?: string; delaySeconds?: number };

type WorkflowRunState = {
  data: WorkflowRunData;
  // When submit arrives before create (events.create and queue() race in
  // upstream's start path), we record the request here. create then picks
  // it up and dispatches the workflow.
  pendingSubmit: SubmitOpts;
};

// Internal helper: dispatch the workflow service and store invocationId.
// Caller must already hold the exclusive lock on this key (so it's safe
// to read+write state synchronously). Returns the running state.
//
// The workflow service handler (restateHandler) reports its own terminal
// state back via workflowRunObj.report() when it exits, so no separate
// waitForCompletion reconciler is needed.
async function dispatchWorkflow(
  ctx: ObjectContext<WorkflowRunState>,
  data: WorkflowRunData,
  opts: SubmitOpts
): Promise<WorkflowRunData> {
  const handle = ctx.genericSend({
    service: data.serviceName,
    method: "run",
    parameter: {
      serviceName: data.serviceName,
      payload: data.serializedInput,
      runId: ctx.key,
      workflowName: data.workflowName,
    },
    inputSerde: serde.json,
    ...(opts.delaySeconds ? { delay: opts.delaySeconds * 1000 } : {}),
    ...(opts.idempotencyKey ? { idempotencyKey: opts.idempotencyKey } : {}),
  });

  const invocationId = await handle.invocationId;
  const runningData: WorkflowRunData = {
    ...data,
    invocationId: invocationId.toString(),
    status: "running" as const,
  };
  ctx.set("data", runningData);

  return runningData;
}

type ReportInput =
  | { status: "completed"; output: unknown }
  | { status: "failed"; error: string }
  | { status: "cancelled" };

export const workflowRunObj = object({
  name: "workflowRun",
  handlers: {
    create: async (
      ctx: ObjectContext<WorkflowRunState>,
      input: { workflowName: string; serviceName: string; input: string }
    ): Promise<WorkflowRunData> => {
      // create is idempotent: if state already exists, return it.
      const existing = await ctx.get("data");
      if (existing) return existing;

      const data: WorkflowRunData = {
        runId: ctx.key,
        workflowName: input.workflowName,
        status: "pending" as const,
        createdAt: await ctx.date.now(),
        serviceName: input.serviceName,
        serializedInput: input.input,
      };
      ctx.set("data", data);

      // If submit raced ahead of us, dispatch now.
      const pending = await ctx.get("pendingSubmit");
      if (pending) {
        ctx.clear("pendingSubmit");
        return dispatchWorkflow(ctx, data, pending);
      }

      return data;
    },

    submit: async (
      ctx: ObjectContext<WorkflowRunState>,
      input: SubmitOpts
    ) => {
      const data = await ctx.get("data");
      if (!data) {
        // Race: create hasn't run yet. Record the request and let create
        // dispatch when it arrives. Returning normally avoids the retry storm
        // we'd otherwise get from a non-terminal "missing state" error.
        ctx.set("pendingSubmit", input);
        return;
      }

      // Idempotent: skip if already submitted
      if (data.status !== "pending") return;

      await dispatchWorkflow(ctx, data, input);
    },

    // Called by the workflow service handler when it exits, and by cancel()
    // after it has issued a cancel signal. Idempotent: if the run already
    // reached a terminal state, subsequent reports are ignored, so reports
    // racing with each other can't overwrite each other.
    report: async (
      ctx: ObjectContext<WorkflowRunState>,
      input: ReportInput
    ): Promise<void> => {
      const data = await ctx.get("data");
      if (!data) return;
      if (data.status !== "running") return;

      const completedAt = await ctx.date.now();
      const next: WorkflowRunData = {
        ...data,
        status: input.status,
        completedAt,
        ...(input.status === "completed" ? { output: input.output } : {}),
        ...(input.status === "failed" ? { error: input.error } : {}),
      };
      ctx.set("data", next);
    },

    get: handlers.object.shared(
      async (ctx: ObjectSharedContext<WorkflowRunState>) => {
        return await ctx.get("data");
      }
    ),

    // Wait for the workflow invocation to complete and return the final state.
    // Shared so it can run concurrently with the exclusive create / submit /
    // waitForCompletion handlers.
    awaitResult: handlers.object.shared(
      async (ctx: ObjectSharedContext<WorkflowRunState>) => {
        // The caller may invoke awaitResult before events.create has finished
        // (start.ts fires events.create and queue() in parallel and returns
        // the run handle eagerly). Poll for state to appear before failing.
        let data = await ctx.get("data");
        let waited = 0;
        while (!data && waited < 30_000) {
          await ctx.sleep(100);
          waited += 100;
          data = await ctx.objectClient(workflowRunObj, ctx.key).get();
        }
        if (!data) {
          throw new TerminalError(`Workflow run ${ctx.key} not found`);
        }

        // Wait for create/submit to dispatch (handles create↔submit race)
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

    const startTimeMs = await restateCtx.date.now();
    const useStep = createUseStep(workflowContext, runId, {
      workflowName,
      serviceName,
      workflowStartedAt: startTimeMs,
    });
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
    // @ts-expect-error - `@types/node` says symbol is not valid, but it does work
    vmGlobalThis[WORKFLOW_CONTEXT] = {
      workflowRunId: runId,
      workflowName: workflowName,
      get workflowStartedAt() {
        return new Date(startTimeMs);
      },
      get url(): string {
        // Upstream's `WorkflowMetadata.url` semantically means "the URL where
        // the workflow can be triggered." Vercel's bundled `createWebhook`
        // appends `/.well-known/workflow/v1/webhook/<token>` to this — but we
        // intercept `hook.url` for webhooks via Object.defineProperty (see
        // createCreateHook below) so the appended path is silently ignored.
        // For any user code that reads `getWorkflowMetadata().url` directly,
        // returning the Restate ingress URL is the most useful default.
        return getIngressUrl();
      },
      // Required by upstream's WorkflowMetadata shape. We don't implement
      // World.getEncryptionKeyForRun, so encryption is never on.
      features: { encryption: false },
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

    const result = await workflowFn(...args);

    // Self-report success. The send is journaled, so it's delivered even
    // though we return immediately afterwards.
    restateCtx
      .objectSendClient(workflowRunObj, runId)
      .report({ status: "completed", output: result });
    return result;
  } catch (err) {
    // VM errors have a different Error prototype, so `instanceof Error` fails
    // in the Restate SDK. Convert them to host Errors first.
    const hostErr = ensureHostError(err);

    // FatalError → convert to TerminalError, report failed, throw terminal.
    if (isFatalError(hostErr)) {
      const message = (hostErr as Error).message;
      restateCtx
        .objectSendClient(workflowRunObj, runId)
        .report({ status: "failed", error: message });
      throw new TerminalError(message);
    }

    // TerminalError → distinguish cancellation (409) from failure, then re-throw.
    if (hostErr instanceof TerminalError) {
      const reportInput: ReportInput =
        hostErr.code === 409
          ? { status: "cancelled" }
          : { status: "failed", error: hostErr.message };
      restateCtx.objectSendClient(workflowRunObj, runId).report(reportInput);
      throw hostErr;
    }

    // Non-terminal error → let Restate retry; do NOT report.
    throw hostErr;
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

  // Expose Web APIs / Web Streams globals needed by bundled library code
  // (e.g. AI SDK's EventSourceParserStream). The upstream builder creates one
  // monolithic bundle, so transitive dependencies are unavoidable.
  g.TransformStream = globalThis.TransformStream;
  g.ReadableStream = globalThis.ReadableStream;
  g.WritableStream = globalThis.WritableStream;
  g.TextDecoderStream = globalThis.TextDecoderStream;
  g.Headers = globalThis.Headers;
  g.Request = globalThis.Request;
  g.Response = globalThis.Response;
  g.TextEncoder = globalThis.TextEncoder;
  g.TextDecoder = globalThis.TextDecoder;
  g.URL = globalThis.URL;
  g.URLSearchParams = globalThis.URLSearchParams;
  g.structuredClone = globalThis.structuredClone;

  // Propagate environment variables
  (g as Record<string, unknown>).process = {
    env: Object.freeze({ ...process.env }),
  };

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

// workflow@5+ inlines step registration as an IIFE that writes to this global
// symbol. The legacy ./internal/private path is no longer called.
const REGISTERED_STEPS_SYMBOL = Symbol.for("@workflow/core//registeredSteps");

type StepFn = (...args: unknown[]) => unknown;

function getRegisteredSteps(): Map<string, StepFn> | undefined {
  return (globalThis as unknown as Record<symbol, Map<string, StepFn>>)[
    REGISTERED_STEPS_SYMBOL
  ];
}

// Mirrors upstream's getStepIdAliasCandidates: tolerates ./workflows ↔ ./src/workflows
// ↔ ./example/workflows path differences in mixed symlink environments.
function stepIdAliases(stepId: string): string[] {
  const parts = stepId.split("//");
  if (parts.length !== 3 || parts[0] !== "step") return [];
  const [, modulePath, fnName] = parts;
  const aliases = new Set<string>();
  const add = (p: string) => {
    if (p !== modulePath) aliases.add(p);
  };
  if (modulePath!.startsWith("./workflows/")) {
    const rel = modulePath!.slice("./".length);
    add(`./example/${rel}`);
    add(`./src/${rel}`);
  } else if (modulePath!.startsWith("./example/workflows/")) {
    const rel = modulePath!.slice("./example/".length);
    add(`./${rel}`);
    add(`./src/${rel}`);
  } else if (modulePath!.startsWith("./src/workflows/")) {
    const rel = modulePath!.slice("./src/".length);
    add(`./${rel}`);
    add(`./example/${rel}`);
  }
  return [...aliases].map((p) => `step//${p}//${fnName}`);
}

function lookupStep(stepId: string): StepFn | undefined {
  const upstream = getRegisteredSteps();
  if (upstream) {
    const direct = upstream.get(stepId);
    if (direct) return direct;
    for (const alias of stepIdAliases(stepId)) {
      const hit = upstream.get(alias);
      if (hit) return hit;
    }
  }
  return globalStepRegistry.get(stepId);
}

function listAvailableSteps(): string[] {
  const upstream = getRegisteredSteps();
  const keys = new Set<string>();
  if (upstream) for (const k of upstream.keys()) keys.add(k);
  for (const k of globalStepRegistry.keys()) keys.add(k);
  return [...keys];
}

interface WorkflowMeta {
  workflowName: string;
  serviceName: string;
  workflowStartedAt: number;
}

// `getStepMetadata()` / `getWorkflowMetadata()` from inside step bodies are
// NOT supported in this World. Upstream wires them via Node AsyncLocalStorage,
// which requires us to manage our own retry loop so we can populate `attempt`
// on every retry — Restate's `ctx.run` does its own internal retry and doesn't
// expose the attempt counter to the closure. Maintaining the parallel retry
// machinery was a meaningful complexity tax for one helper, so v1 doesn't
// expose stepMetadata. Users who need per-step metadata should derive it
// explicitly from step arguments. See README "Known limitations."
//
// The wrapper below relies on Restate's built-in retry policy + delay handling.
function createUseStep(
  ctx: WorkflowOrchestratorContext,
  _runId: string,
  _meta: WorkflowMeta
) {
  return function useStep<Args extends unknown[], Result>(stepName: string) {
    const shortName = parseStepName(stepName)?.shortName ?? stepName;

    const stepFunction = (...args: Args): Promise<Result> => {
      const stepFn = lookupStep(stepName);
      if (stepFn === undefined) {
        throw new Error(
          `Can't find ${stepName} in the global registry. Available steps: ${listAvailableSteps().join(", ")}`
        );
      }

      // Vercel's stepFn.maxRetries counts retries-after-first-attempt.
      // Restate's maxRetryAttempts counts total attempts (including the first).
      // Translate: total = maxRetries + 1. Omit when unset so Restate uses its
      // service-default policy.
      const stepMaxRetries = (stepFn as { maxRetries?: number }).maxRetries;

      const runAction = async () => {
        try {
          const result = await (stepFn(...args) as Promise<Result>);
          // Native Response objects JSON-serialize to "{}" because their
          // properties are non-enumerable getters.  Convert to a plain
          // serializable form so Restate can journal it.
          if (result instanceof Response) {
            return (await serializeResponse(result)) as unknown as Result;
          }
          return result;
        } catch (err) {
          // FatalError → throw a TerminalError that also passes Vercel's
          // FatalError.is() identity check (`name === "FatalError"`).
          // Restate sees TerminalError and stops retrying.
          if (isFatalError(err)) {
            throw new FatalTerminalError(err.message);
          }
          // Vercel's RetryableError → Restate's RetryableError with the
          // user-requested delay (translated from absolute Date to duration).
          if (isVercelRetryableError(err)) {
            const ms = Math.max(0, err.retryAfter.getTime() - Date.now());
            throw new RestateRetryableError(err.message, { retryAfter: ms });
          }
          throw err;
        }
      };

      const runPromise =
        typeof stepMaxRetries === "number"
          ? ctx.restateCtx.run(shortName, runAction, {
              maxRetryAttempts: stepMaxRetries + 1,
            })
          : ctx.restateCtx.run(shortName, runAction);

      return runPromise.then((result: Result) => {
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

/**
 * Reader side of an invocation-scoped signal stream.
 *
 * Reusing the same signal name acts as a FIFO queue: each `next()` consumes
 * the next resolved value, in the order the writer appended them.
 */
class SignalStreamReader<T> implements AsyncIterableIterator<T> {
  constructor(
    private readonly ctx: internal.ContextInternal,
    private readonly name: string
  ) {}

  next(): Promise<IteratorResult<T>> {
    return this.ctx.signal<IteratorResult<T>>(this.name);
  }

  [Symbol.asyncIterator](): this {
    return this;
  }
}

/** Writer side: append/end via signals targeting another invocation. */
class SignalStreamWriter<T> {
  constructor(
    private readonly target: internal.InvocationReference,
    private readonly name: string
  ) {}

  append(value: T): void {
    this.target
      .signal<IteratorResult<T>>(this.name)
      .resolve({ done: false, value });
  }

  end(): void {
    this.target
      .signal<IteratorResult<T>>(this.name)
      .resolve({ done: true, value: undefined });
  }
}

export function createCreateHook(ctx: WorkflowOrchestratorContext, runId: string) {
  const ctxInternal = ctx.restateCtx as unknown as internal.ContextInternal;
  return function createHookImpl<T = unknown>(
    options: HookOptions = {}
  ): Hook<T> {
    const signalName = `hook-${ctx.restateCtx.rand.uuidv4()}`;
    const token = options.token ?? signalName;
    const isWebhook = options.isWebhook ?? false;
    const workflowInvocationId = ctx.restateCtx.request().id.toString();

    // Register hook with the workflow's invocation + signal name so
    // hookObj.resolve can target the correct invocation/signal.
    ctx.restateCtx.objectSendClient(hookObj, token).create({
      runId,
      workflowInvocationId,
      signalName,
      isWebhook,
      metadata: options.metadata,
    });

    const reader = new SignalStreamReader<unknown>(ctxInternal, signalName);

    function unwrap(value: unknown): T {
      if (!isWebhook) return value as T;

      // Two possible shapes for a webhook value:
      //   1. Full `SerializedRequest` ({ method, url, headers, body }) —
      //      sent by `resumeWebhook` when the legacy Next.js webhook route
      //      receives the request and forwards it.
      //   2. Raw JSON body — when an external caller POSTs the body directly
      //      to Restate's ingress at `${RESTATE_INGRESS}/workflowHooks/<token>/resolve`.
      //      Restate doesn't preserve method/headers/URL of the caller's
      //      request; only the JSON body becomes the resolve input.
      //
      // Detect by shape. For case 2 we synthesize a Request so workflow code
      // doing `await webhook.json()` / `request.method` keeps working
      // (method defaults to POST, body is the JSON value).
      if (
        typeof value === "object" &&
        value !== null &&
        "method" in value &&
        "url" in value &&
        "headers" in value &&
        "body" in value
      ) {
        return deserializeRequest(value as SerializedRequest) as T;
      }
      return new Request("http://localhost/", {
        method: "POST",
        headers: new Headers({ "content-type": "application/json" }),
        body: JSON.stringify(value ?? null),
      }) as T;
    }

    async function nextValue(): Promise<IteratorResult<T>> {
      const res = await reader.next();
      if (res.done) return { done: true, value: undefined };
      return { done: false, value: unwrap(res.value) };
    }

    const hook: Hook<T> = {
      token,

      // biome-ignore lint/suspicious/noThenProperty: Intentionally thenable
      then<TResult1 = T, TResult2 = never>(
        onfulfilled?: ((value: T) => TResult1 | PromiseLike<TResult1>) | null,
        onrejected?:
          | ((reason: unknown) => TResult2 | PromiseLike<TResult2>)
          | null
      ): Promise<TResult1 | TResult2> {
        return nextValue().then((res) => {
          if (res.done) {
            throw new Error("Hook was disposed before a value arrived");
          }
          return res.value;
        }, undefined).then(onfulfilled, onrejected);
      },

      dispose() {
        ctx.restateCtx.objectSendClient(hookObj, token).dispose();
      },

      [Symbol.dispose]() {
        this.dispose();
      },

      // `for await (const payload of hook) { … }` — terminates on dispose.
      [Symbol.asyncIterator](): AsyncIterableIterator<T> {
        return {
          next: nextValue,
          [Symbol.asyncIterator]() {
            return this;
          },
        };
      },
    };

    // Also register with the VM's Symbol.dispose if it differs from the host's.
    // vm.createContext() has its own Symbol constructor where dispose may be
    // polyfilled to a different value than the host's native Symbol.dispose.
    const vmDispose = (ctx.globalThis.Symbol as Record<string, unknown>)?.dispose as symbol | undefined;
    if (vmDispose && vmDispose !== Symbol.dispose) {
      (hook as unknown as Record<symbol, unknown>)[vmDispose] = () => hook.dispose();
    }

    // Webhook URL — for webhook hooks, point directly at Restate's ingress so
    // external callers POST straight to `workflowHooks/<token>/resolve` without
    // an intermediary Next.js route.
    //
    // Vercel's bundled createWebhook does `hook.url = ${metadata.url}/.well-known/workflow/v1/webhook/<token>`
    // unconditionally after our createHookImpl returns. We define `url` as a
    // getter/no-op-setter pair so Vercel's assignment is silently absorbed and
    // the getter always returns our Restate-ingress URL.
    if (isWebhook) {
      const ingress = getIngressUrl();
      const restateWebhookUrl = `${ingress}/workflowHooks/${encodeURIComponent(token)}/resolve`;
      Object.defineProperty(hook, "url", {
        get() {
          return restateWebhookUrl;
        },
        set() {
          // Swallow Vercel's `hook.url = ...` assignment from the bundled
          // createWebhook wrapper. We control the URL.
        },
        enumerable: true,
        configurable: false,
      });
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
//
// Uses Restate's signal API to support repeated resolution: each resolve
// signals `{done: false, value}` to the workflow's invocation under the
// hook's signal name; dispose signals `{done: true}`. The signal infra
// queues per-name FIFO, so no buffer is needed in this object's state.
// ---------------------------------------------------------------------------

type HooksState = {
  workflowInvocationId: string;
  signalName: string;
  runId: string;
  createdAt: number;
  isWebhook: boolean;
  metadata: unknown;
  closed: boolean;
};

export const hookObj = object({
  name: "workflowHooks",
  handlers: {
    create: async (
      ctx: ObjectContext<HooksState>,
      input: {
        runId: string;
        workflowInvocationId: string;
        signalName: string;
        isWebhook?: boolean;
        metadata?: unknown;
      }
    ) => {
      // Reject duplicate token while a previous hook is still active
      if ((await ctx.get("signalName")) !== null) {
        throw new TerminalError("Hook already exists", { errorCode: 409 });
      }

      ctx.set("workflowInvocationId", input.workflowInvocationId);
      ctx.set("signalName", input.signalName);
      ctx.set("runId", input.runId);
      ctx.set("createdAt", await ctx.date.now());
      ctx.set("isWebhook", input.isWebhook ?? false);
      ctx.set("metadata", input.metadata ?? null);
      ctx.set("closed", false);
    },
    resolve: async (
      ctx: ObjectContext<HooksState>,
      input: unknown
    ): Promise<{ invocationId: string }> => {
      const signalName = await ctx.get("signalName");
      const workflowInvocationId = await ctx.get("workflowInvocationId");
      if (!signalName || !workflowInvocationId) {
        throw new TerminalError("Hook not found");
      }
      if (await ctx.get("closed")) {
        throw new TerminalError("Hook is disposed");
      }
      const ctxInternal = ctx as unknown as internal.ContextInternal;
      const writer = new SignalStreamWriter<unknown>(
        ctxInternal.invocation(InvocationIdParser.fromString(workflowInvocationId)),
        signalName
      );
      writer.append(input);
      return { invocationId: workflowInvocationId };
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
    dispose: async (ctx: ObjectContext<HooksState>) => {
      const closed = (await ctx.get("closed")) ?? false;
      const signalName = await ctx.get("signalName");
      const workflowInvocationId = await ctx.get("workflowInvocationId");
      if (!closed && signalName && workflowInvocationId) {
        const ctxInternal = ctx as unknown as internal.ContextInternal;
        const writer = new SignalStreamWriter<unknown>(
          ctxInternal.invocation(
            InvocationIdParser.fromString(workflowInvocationId)
          ),
          signalName
        );
        writer.end();
      }
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

export type {
  HealthCheckEndpoint,
  HealthCheckOptions,
  HealthCheckResult,
} from "@workflow/core/runtime";

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
