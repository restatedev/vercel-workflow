import { Event, Hook, Step, WorkflowRun } from "@workflow/world";
import {
  ObjectContext,
  TerminalError,
  TypedState,
} from "@restatedev/restate-sdk";
import { JsonTransport } from "@vercel/queue";

export const DEFAULT_RESOLVE_DATA_OPTION = "all";

// Helper functions to filter data based on resolveData setting
export function filterRunData(
  run: WorkflowRun,
  resolveData?: "none" | "all"
): WorkflowRun {
  if (resolveData === "none") {
    return {
      ...run,
      input: [],
      output: undefined,
    };
  }
  return run;
}

export function filterStepData(step: Step, resolveData?: "none" | "all"): Step {
  if (resolveData === "none") {
    return {
      ...step,
      input: [],
      output: undefined,
    };
  }
  return step;
}

export function filterEventData(
  event: Event,
  resolveData?: "none" | "all"
): Event {
  if (resolveData === "none") {
    const { eventData: _eventData, ...rest } = event as any;
    return rest;
  }
  return event;
}

export function filterHookData(hook: Hook, resolveData?: "none" | "all"): Hook {
  if (resolveData === "none") {
    const { metadata: _metadata, ...rest } = hook as any;
    return rest;
  }
  return hook;
}

export async function getStateKeysByPrefix<S extends TypedState>(
  ctx: ObjectContext<S>,
  prefix: string
) {
  const allKeys = (await ctx.stateKeys()) ?? [];
  return allKeys.filter((key) => key.startsWith(prefix));
}

export const jsonTransport = new JsonTransport();

export function queueUrl(deliverTo: string, queueName: string) {
  let pathname: string;
  if (queueName.startsWith("__wkf_step_")) {
    pathname = `step`;
  } else if (queueName.startsWith("__wkf_workflow_")) {
    pathname = `flow`;
  } else {
    throw new TerminalError("Unknown queue name prefix");
  }

  return `${deliverTo}/.well-known/workflow/v1/${pathname}`;
}
