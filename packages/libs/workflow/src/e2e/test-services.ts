/**
 * Simple Restate services used by the E2E test suite.
 *
 * These simulate a minimal workflow service so we can test the
 * workflowRunObj lifecycle (submit → run → awaitResult) end-to-end
 * without needing the SWC compilation pipeline.
 */
import { service, TerminalError } from "@restatedev/restate-sdk/fetch";

/**
 * A simple service that echoes a computed result.
 * workflowRunObj.submit dispatches to "{serviceName}/run",
 * so this service name must match the serviceName stored in the run.
 */
export const echoService = service({
  name: "echoService",
  handlers: {
    run: async (
      _ctx,
      input: {
        serviceName: string;
        payload: string;
        runId: string;
        workflowName: string;
      }
    ) => {
      const args = JSON.parse(input.payload) as unknown[];
      // Simple addition: expect [a, b] → return a + b
      if (args.length === 2 && typeof args[0] === "number" && typeof args[1] === "number") {
        return args[0] + args[1];
      }
      return args;
    },
  },
});

/**
 * A service that sleeps for a very long time (used to test cancellation).
 */
export const slowService = service({
  name: "slowService",
  handlers: {
    run: async (
      ctx,
      _input: {
        serviceName: string;
        payload: string;
        runId: string;
        workflowName: string;
      }
    ) => {
      // Sleep for 1 hour — will be cancelled
      await ctx.sleep(3_600_000);
      return "should not reach here";
    },
  },
});

/**
 * A service that throws a TerminalError (simulates FatalError).
 */
export const failingService = service({
  name: "failingService",
  handlers: {
    run: async (
      _ctx,
      _input: {
        serviceName: string;
        payload: string;
        runId: string;
        workflowName: string;
      }
    ) => {
      throw new TerminalError("intentional failure");
    },
  },
});
