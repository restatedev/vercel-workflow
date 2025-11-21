import {
  Context,
  createEndpointHandler,
  object,
  ObjectContext,
  service,
} from "@restatedev/restate-sdk/fetch";
import * as serialization from "@workflow/core/serialization";
import { createContext as vmCreateContext, runInContext } from "node:vm";
import { parseStepName, parseWorkflowName } from "./parse-name.js";
import { globalStepRegistry } from "./internal/private.js";
import { WORKFLOW_USE_STEP, WORKFLOW_CREATE_HOOK } from "./symbols.js";
import { Hook, HookOptions } from "@workflow/core";

export function workflowEntrypoint(workflowCode: string) {
  return createEndpointHandler({
    services: [createService(workflowCode), hookObj],
  });
}

export function stepEntrypoint() {}

function createService(workflowCode: string) {
  return service({
    name: "handleUserSignup",
    handlers: {
      run: (ctx, input) => restateHandler(ctx, workflowCode, input),
    },
  });
}

interface WorkflowOrchestratorContext {
  globalThis: any;
  restateCtx: Context;
}

async function restateHandler(
  restateCtx: Context,
  workflowCode: string,
  input: any
) {
  const { context, globalThis: vmGlobalThis } = createContext(restateCtx);

  // TODO how do i extract this?!
  //  Probably create service above needs to loop through `globalThis.__private_workflows` in the generated code
  const workflowName =
    "workflow//src/workflows/user-signup.ts//handleUserSignup";

  const workflowContext: WorkflowOrchestratorContext = {
    globalThis: vmGlobalThis,
    restateCtx,
  };

  const useStep = createUseStep(workflowContext);
  const createHook = createCreateHook(workflowContext);

  // @ts-expect-error - `@types/node` says symbol is not valid, but it does work
  vmGlobalThis[WORKFLOW_USE_STEP] = useStep;
  // @ts-expect-error - `@types/node` says symbol is not valid, but it does work
  vmGlobalThis[WORKFLOW_CREATE_HOOK] = createHook;

  // Get a reference to the user-defined workflow function.
  // The filename parameter ensures stack traces show a meaningful name
  // (e.g., "example/workflows/99_e2e.ts") instead of "evalmachine.<anonymous>".
  const parsedName = parseWorkflowName(workflowName);
  const filename = parsedName?.path || workflowName;

  const workflowFn = runInContext(
    `${workflowCode}; globalThis.__private_workflows?.get(${JSON.stringify(workflowName)})`,
    context,
    { filename }
  );

  if (typeof workflowFn !== "function") {
    throw new ReferenceError(
      `Workflow ${JSON.stringify(
        workflowName
      )} must be a function, but got "${typeof workflowFn}" instead`
    );
  }

  const args = serialization.hydrateWorkflowArguments([input], vmGlobalThis);

  // Invoke user workflow
  const result = await workflowFn(...args);
  return result;

  // TODO the return value here is serializable? how this hydrate/dehydrate thing works even?
  //return serialization.dehydrateWorkflowReturnValue(result, vmGlobalThis);
}

function createContext(restateCtx: Context) {
  const context = vmCreateContext();

  const g: typeof globalThis = runInContext("globalThis", context);

  // Hook console
  g.console = restateCtx.console;

  // HACK: Shim `exports` for the bundle
  // TODO(slinkydeveloper) seems important, need to figure out why
  g.exports = {};
  (g as any).module = { exports: g.exports };

  return {
    context,
    globalThis: g,
  };
}

function createUseStep(ctx: WorkflowOrchestratorContext) {
  return function useStep<Args extends any[], Result>(stepName: string) {
    const stepFunction = (...args: Args): Promise<Result> => {
      const stepFn = globalStepRegistry.get(stepName);
      if (stepFn === undefined) {
        throw new Error(
          `Can't find ${stepName} in the global registry. Available steps: ${globalStepRegistry.keys()}`
        );
      }

      return ctx.restateCtx.run(
        parseStepName(stepName)?.shortName ?? stepName,
        () => stepFn(...args)
        // TODO figure out how to connect to their serde stack
        // {
        //   serde: {
        //     serialize: function (value: unknown): Uint8Array {
        //       const hydratedResult = serialization.dehydrateStepReturnValue(
        //         value,
        //         ctx.globalThis
        //       );
        //     },
        //     deserialize: function (data: Uint8Array): unknown {
        //       throw new Error("Function not implemented.");
        //     },
        //     contentType: "application/json",
        //   },
        // }
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

export function createCreateHook(ctx: WorkflowOrchestratorContext) {
  return function createHookImpl<T = any>(options: HookOptions = {}): Hook<T> {
    // Generate hook ID or token
    const token = options.token ?? ctx.restateCtx.rand.uuidv4();
    const { id, promise } = ctx.restateCtx.awakeable();

    // Register hook
    ctx.restateCtx.objectSendClient(hookObj, token).createAndSubscribe({
      invocationId: ctx.restateCtx.request().id,
      awakeableId: id,
    });

    const hook: Hook<T> = {
      token,

      // biome-ignore lint/suspicious/noThenProperty: Intentionally thenable
      then<TResult1 = T, TResult2 = never>(
        onfulfilled?: ((value: T) => TResult1 | PromiseLike<TResult1>) | null,
        onrejected?: ((reason: any) => TResult2 | PromiseLike<TResult2>) | null
      ): Promise<TResult1 | TResult2> {
        return (promise as Promise<T>).then(onfulfilled, onrejected);
      },

      // Support `for await (const payload of hook) { … }` syntax
      async *[Symbol.asyncIterator]() {
        while (true) {
          yield await this;
        }
      },
    };

    return hook;
  };
}

type HookMetadata = {
  invocationId: string;
};

type HooksState = {
  result: any;
  metadata: HookMetadata;
  subscribers: string[];
};

const hookObj = object({
  name: "workflowHooks",
  handlers: {
    createAndSubscribe: async (
      ctx: ObjectContext<HooksState>,
      input: HookMetadata & {
        awakeableId: string;
      }
    ) => {
      // If there's input, easily solved
      const result = await ctx.get("result");
      if (result !== null) {
        ctx.resolveAwakeable(input.awakeableId, result);
        return;
      }

      // Set metadata
      if ((await ctx.get("metadata")) === null) {
        ctx.set("metadata", {
          invocationId: input.invocationId,
        });
      }

      // Update subscribers
      const subs = (await ctx.get("subscribers")) ?? [];
      subs.push(input.awakeableId);
      ctx.set("subscribers", subs);
    },
    resolve: async (
      ctx: ObjectContext<HooksState>,
      input: any
    ): Promise<HookMetadata> => {
      const result = (await ctx.get("result")) ?? input;
      const subs = (await ctx.get("subscribers")) ?? [];
      for (const sub of subs) {
        ctx.resolveAwakeable(sub, result);
      }
      ctx.clear("subscribers");
      ctx.set("result", result);
      return (await ctx.get("metadata"))!!;
    },
    dispose: async (ctx: ObjectContext) => {
      ctx.clearAll();
    },
  },
});
