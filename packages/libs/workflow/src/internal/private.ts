export const globalStepRegistry = new Map();

export function registerStepFunction(entityId: string, fn: any) {
  // Entity id example format: "step//src/workflows/user-signup.ts//sendWelcomeEmail"
  globalStepRegistry.set(entityId, fn);
}
