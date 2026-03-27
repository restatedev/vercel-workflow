export const globalStepRegistry = new Map<
  string,
  (...args: unknown[]) => unknown
>();

export function registerStepFunction(
  entityId: string,
  fn: (...args: unknown[]) => unknown
) {
  // Entity id example format: "step//src/workflows/user-signup.ts//sendWelcomeEmail"
  globalStepRegistry.set(entityId, fn);
}

/**
 * Returns closure variables for the current step function.
 * Required by the upstream SWC plugin's compiled output which imports this
 * from `workflow/internal/private`. In the Restate runtime, step functions
 * execute inside a VM sandbox where closures are handled natively, so this
 * is a no-op stub that satisfies the import.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function __private_getClosureVars(): Record<string, any> {
  return {};
}
