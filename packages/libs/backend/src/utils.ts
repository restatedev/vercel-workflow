import { Hook, Step, WorkflowRun } from "@workflow/world";

export const DEFAULT_RESOLVE_DATA_OPTION = "all";

// Helper functions to filter data based on resolveData setting
export function filterRunData(
  run: WorkflowRun,
  resolveData: "none" | "all"
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

export function filterStepData(step: Step, resolveData: "none" | "all"): Step {
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
  resolveData: "none" | "all"
): Event {
  if (resolveData === "none") {
    const { eventData: _eventData, ...rest } = event as any;
    return rest;
  }
  return event;
}

export function filterHookData(hook: Hook, resolveData: "none" | "all"): Hook {
  if (resolveData === "none") {
    const { metadata: _metadata, ...rest } = hook as any;
    return rest;
  }
  return hook;
}
