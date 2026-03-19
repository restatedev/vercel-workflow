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
