/* eslint-disable @typescript-eslint/no-unsafe-return */
/* eslint-disable @typescript-eslint/no-unsafe-assignment */
import { FatalError, RetryableError, getStepMetadata } from "workflow";

/**
 * Simplest example of a workflow with multiple steps
 */

async function callApi(endpoint: string) {
  "use step";
  const metadata = getStepMetadata();
  const response = await fetch(endpoint);
  if (response.status >= 500) {
    // Exponential backoffs
    throw new RetryableError("Backing off...", {
      retryAfter: metadata.attempt ** 2 * 1000,
    });
  }
  if (response.status === 404) {
    throw new FatalError("Resource not found. Skipping retries.");
  }
  if (response.status === 429) {
    throw new RetryableError("Rate limited. Retrying...", {
      retryAfter: new Date(Date.now() + 60000), // Date instance
    });
  }
  return response.json();
}
callApi.maxRetries = 5; // Retry up to 5 times on failure (6 total attempts)

export async function callApiWorkflow(endpoint: string) {
  "use workflow";

  const result = await callApi(endpoint);

  return {
    result,
  };
}
