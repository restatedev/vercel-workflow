/* eslint-disable @typescript-eslint/no-unsafe-return */
/* eslint-disable @typescript-eslint/no-unsafe-assignment */
import { FatalError } from "workflow";

/**
 * Simplest example of a workflow with multiple steps
 */

async function callApi(endpoint: string) {
  "use step";
  const response = await fetch(endpoint);
  if (response.status >= 500) {
    // Any uncaught error gets retried
    throw new Error("Uncaught exceptions get retried!");
  }
  if (response.status === 404) {
    throw new FatalError("Resource not found. Skipping retries.");
  }
  return response.json();
}

export async function callApiWorkflow(endpoint: string) {
  "use workflow";

  const result = await callApi(endpoint);

  return {
    result,
  };
}
