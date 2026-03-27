import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// --- Mocks ---

const mockObjectClient = vi.fn();
vi.mock("@restatedev/restate-sdk-clients", () => ({
  connect: () => ({
    objectClient: mockObjectClient,
    objectSendClient: vi.fn(),
  }),
}));

// Mock runtime.ts to provide stub virtual object definitions
// (avoids importing the real Restate SDK)
vi.mock("./runtime.js", () => ({
  workflowRunObj: { name: "workflowRun" },
  sleepObj: { name: "workflowSleep" },
  hookObj: { name: "workflowHooks" },
}));

// Mock TerminalError
class MockTerminalError extends Error {
  code?: number;
  constructor(message: string, opts?: { errorCode?: number }) {
    super(message);
    this.name = "TerminalError";
    this.code = opts?.errorCode;
  }
}

vi.mock("@restatedev/restate-sdk/fetch", () => ({
  TerminalError: MockTerminalError,
}));

// Mock @workflow/core/runtime
class MockCoreRun {
  runId: string;
  constructor(runId: string) {
    this.runId = runId;
  }
}

const mockCoreStart = vi.fn().mockResolvedValue(new MockCoreRun("wrun_mock_123"));

vi.mock("@workflow/core/runtime", () => ({
  Run: MockCoreRun,
  start: (...args: unknown[]) => mockCoreStart(...args) as unknown,
  runStep: vi.fn(),
}));

// Mock @workflow/errors
class MockCancelledError extends Error {
  constructor(runId: string) {
    super(`Workflow run ${runId} was cancelled`);
    this.name = "WorkflowRunCancelledError";
  }
}
class MockFailedError extends Error {
  constructor(runId: string, error: { message: string }) {
    super(`Workflow run ${runId} failed: ${error.message}`);
    this.name = "WorkflowRunFailedError";
  }
}

vi.mock("@workflow/errors", () => ({
  WorkflowRunCancelledError: MockCancelledError,
  WorkflowRunFailedError: MockFailedError,
}));

// Mock index.js to avoid its own dependencies
vi.mock("./index.js", () => ({
  resumeHook: vi.fn(),
  defineHook: vi.fn(),
}));

const originalEnv = process.env["RESTATE_INGRESS"];
const originalFetch = globalThis.fetch;

beforeEach(() => {
  process.env["RESTATE_INGRESS"] = "http://localhost:8080";
  mockObjectClient.mockReset();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalEnv !== undefined) {
    process.env["RESTATE_INGRESS"] = originalEnv;
  } else {
    delete process.env["RESTATE_INGRESS"];
  }
});

describe("Run", () => {
  async function importApi() {
    return await import("./api.js");
  }

  describe("status", () => {
    it("fetches status from workflowRunObj.get()", async () => {
      mockObjectClient.mockReturnValue({
        get: vi.fn().mockResolvedValue({ status: "completed" }),
      });

      const { Run } = await importApi();
      const run = new Run("run-1");
      const status = await run.status;

      expect(status).toBe("completed");
    });

    it("throws when run not found", async () => {
      mockObjectClient.mockReturnValue({
        get: vi.fn().mockResolvedValue(null),
      });

      const { Run } = await importApi();
      const run = new Run("nonexistent");
      await expect(run.status).rejects.toThrow("not found");
    });
  });

  describe("exists", () => {
    it("returns true when run data exists", async () => {
      mockObjectClient.mockReturnValue({
        get: vi.fn().mockResolvedValue({ status: "running" }),
      });

      const { Run } = await importApi();
      const run = new Run("run-1");
      expect(await run.exists).toBe(true);
    });

    it("returns false when run data is null", async () => {
      mockObjectClient.mockReturnValue({
        get: vi.fn().mockResolvedValue(null),
      });

      const { Run } = await importApi();
      const run = new Run("run-1");
      expect(await run.exists).toBe(false);
    });
  });

  describe("wakeUp", () => {
    it("wakes up all pending sleeps", async () => {
      const wakeUpMock = vi.fn().mockResolvedValue(undefined);
      mockObjectClient.mockReturnValue({
        getPending: vi.fn().mockResolvedValue([
          { correlationId: "sleep-1", awakeableId: "awk-1" },
          { correlationId: "sleep-2", awakeableId: "awk-2" },
        ]),
        wakeUp: wakeUpMock,
      });

      const { Run } = await importApi();
      const run = new Run("run-1");
      const result = await run.wakeUp();

      expect(result).toEqual({ stoppedCount: 2 });
      expect(wakeUpMock).toHaveBeenCalledTimes(2);
      expect(wakeUpMock).toHaveBeenCalledWith({ correlationId: "sleep-1" });
      expect(wakeUpMock).toHaveBeenCalledWith({ correlationId: "sleep-2" });
    });

    it("filters by correlationIds when provided", async () => {
      const wakeUpMock = vi.fn().mockResolvedValue(undefined);
      mockObjectClient.mockReturnValue({
        getPending: vi.fn().mockResolvedValue([
          { correlationId: "sleep-1", awakeableId: "awk-1" },
          { correlationId: "sleep-2", awakeableId: "awk-2" },
          { correlationId: "sleep-3", awakeableId: "awk-3" },
        ]),
        wakeUp: wakeUpMock,
      });

      const { Run } = await importApi();
      const run = new Run("run-1");
      const result = await run.wakeUp({ correlationIds: ["sleep-2"] });

      expect(result).toEqual({ stoppedCount: 1 });
      expect(wakeUpMock).toHaveBeenCalledTimes(1);
      expect(wakeUpMock).toHaveBeenCalledWith({ correlationId: "sleep-2" });
    });

    it("returns stoppedCount 0 when no pending sleeps", async () => {
      mockObjectClient.mockReturnValue({
        getPending: vi.fn().mockResolvedValue([]),
        wakeUp: vi.fn(),
      });

      const { Run } = await importApi();
      const run = new Run("run-1");
      const result = await run.wakeUp();
      expect(result).toEqual({ stoppedCount: 0 });
    });
  });

  describe("returnValue", () => {
    it("returns result from awaitResult", async () => {
      mockObjectClient.mockReturnValue({
        awaitResult: vi.fn().mockResolvedValue({ sum: 42 }),
      });

      const { Run } = await importApi();
      const run = new Run<{ sum: number }>("run-1");
      const value = await run.returnValue;

      expect(value).toEqual({ sum: 42 });
    });

    it("maps TerminalError with code 409 to WorkflowRunCancelledError", async () => {
      mockObjectClient.mockReturnValue({
        awaitResult: vi
          .fn()
          .mockRejectedValue(
            new MockTerminalError("cancelled", { errorCode: 409 })
          ),
      });

      const { Run } = await importApi();
      const run = new Run("run-cancelled");
      await expect(run.returnValue).rejects.toThrow("was cancelled");
    });

    it("maps other TerminalErrors to WorkflowRunFailedError", async () => {
      mockObjectClient.mockReturnValue({
        awaitResult: vi
          .fn()
          .mockRejectedValue(new MockTerminalError("step failed")),
      });

      const { Run } = await importApi();
      const run = new Run("run-failed");
      await expect(run.returnValue).rejects.toThrow("failed");
    });

    it("re-throws non-TerminalErrors", async () => {
      mockObjectClient.mockReturnValue({
        awaitResult: vi.fn().mockRejectedValue(new Error("network error")),
      });

      const { Run } = await importApi();
      const run = new Run("run-err");
      await expect(run.returnValue).rejects.toThrow("network error");
    });
  });
});

describe("getRun", () => {
  it("returns a Run instance with the given runId", async () => {
    const { getRun, Run } = await import("./api.js");
    const run = getRun("run-abc");
    expect(run).toBeInstanceOf(Run);
    expect(run.runId).toBe("run-abc");
  });
});

describe("start", () => {
  it("wraps coreStart and returns our Run subclass", async () => {
    const { start, Run } = await import("./api.js");
    // eslint-disable-next-line @typescript-eslint/require-await
    const workflowFn = async () => ({ result: 1 });

    const run = await start(workflowFn as never, [] as never);
    expect(run).toBeInstanceOf(Run);
    expect(run.runId).toBe("wrun_mock_123");
  });
});

describe("resumeWebhook", () => {
  it("throws when hook does not exist", async () => {
    mockObjectClient.mockReturnValue({
      get: vi.fn().mockResolvedValue(null),
    });

    const { resumeWebhook } = await import("./api.js");
    await expect(
      resumeWebhook("token", new Request("http://example.com"))
    ).rejects.toThrow("Webhook hook not found");
  });

  it("throws when hook exists but is not a webhook", async () => {
    mockObjectClient.mockReturnValue({
      get: vi.fn().mockResolvedValue({
        runId: "run-1",
        isWebhook: false,
      }),
    });

    const { resumeWebhook } = await import("./api.js");
    await expect(
      resumeWebhook("token", new Request("http://example.com"))
    ).rejects.toThrow("Webhook hook not found");
  });

  it("serializes Request and resolves hook", async () => {
    mockObjectClient.mockReturnValue({
      get: vi.fn().mockResolvedValue({
        runId: "run-1",
        isWebhook: true,
      }),
    });

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ invocationId: "inv_wh" }),
    });
    globalThis.fetch = mockFetch;

    const { resumeWebhook } = await import("./api.js");
    const request = new Request("http://example.com/webhook", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ event: "test" }),
    });

    const result = await resumeWebhook("wh-token", request);
    expect(result).toEqual({ invocationId: "inv_wh" });

    const callArgs = mockFetch.mock.calls[0]![1] as { body: string };
    const sentBody = JSON.parse(callArgs.body) as Record<string, unknown>;
    expect(sentBody.method).toBe("POST");
    expect(sentBody.url).toBe("http://example.com/webhook");
    expect(sentBody.body).toBe(JSON.stringify({ event: "test" }));
  });
});
