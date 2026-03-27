import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { World } from "@workflow/world";

// --- Mocks ---

// Mock the Restate clients module
const mockObjectClient = vi.fn();
const mockObjectSendClient = vi.fn();
vi.mock("@restatedev/restate-sdk-clients", () => ({
  connect: () => ({
    objectClient: mockObjectClient,
    objectSendClient: mockObjectSendClient,
  }),
}));

// Mock serialization — pass-through by default
vi.mock("@workflow/core/serialization", () => ({
  hydrateWorkflowArguments: vi.fn(
    (input: unknown) => Promise.resolve(input)
  ),
  hydrateStepArguments: vi.fn(
    (input: unknown) => Promise.resolve(input)
  ),
  dehydrateWorkflowReturnValue: vi.fn(
    (output: unknown) => Promise.resolve(output)
  ),
}));

const originalEnv = process.env["RESTATE_INGRESS"];

beforeEach(() => {
  process.env["RESTATE_INGRESS"] = "http://localhost:8080";
  mockObjectClient.mockReset();
  mockObjectSendClient.mockReset();
});

afterEach(() => {
  if (originalEnv !== undefined) {
    process.env["RESTATE_INGRESS"] = originalEnv;
  } else {
    delete process.env["RESTATE_INGRESS"];
  }
});

// Helper to get a fresh world instance
async function getWorld(): Promise<World> {
  // Dynamic import to pick up mocked env
  const { createWorld } = await import("./world.js");
  return createWorld();
}

describe("createWorld", () => {
  it("throws when RESTATE_INGRESS is not set", async () => {
    delete process.env["RESTATE_INGRESS"];
    const { createWorld } = await import("./world.js");
    expect(() => createWorld()).toThrow("RESTATE_INGRESS");
  });
});

describe("Queue", () => {
  it("getDeploymentId returns 'restate'", async () => {
    const world = await getWorld();
    await expect(world.getDeploymentId()).resolves.toBe("restate");
  });

  it("queue() calls objectSendClient with submit and correct options", async () => {
    const submitMock = vi.fn().mockResolvedValue(undefined);
    mockObjectSendClient.mockReturnValue({ submit: submitMock });

    const world = await getWorld();
    const result = await world.queue(
      "default" as never,
      { runId: "run-123" } as never,
      { idempotencyKey: "key-1", delaySeconds: 10 }
    );

    expect(mockObjectSendClient).toHaveBeenCalled();
    expect(submitMock).toHaveBeenCalledWith({
      idempotencyKey: "key-1",
      delaySeconds: 10,
    });
    expect(result).toEqual({ messageId: "run-123" });
  });

  it("createQueueHandler returns a function that returns 404", async () => {
    const world = await getWorld();
    const handler = world.createQueueHandler(
      "" as never,
      (async () => {}) as never
    );
    const response = await handler(new Request("http://test"));
    expect(response.status).toBe(404);
  });
});

describe("runs", () => {
  it("get() returns a correctly mapped WorkflowRun", async () => {
    mockObjectClient.mockReturnValue({
      get: vi.fn().mockResolvedValue({
        runId: "run-1",
        workflowName: "workflow//src/test.ts//myWorkflow",
        status: "running",
        createdAt: 1700000000000,
        serviceName: "myWorkflow",
        serializedInput: "[]",
      }),
    });

    const world = await getWorld();
    const run = await world.runs.get("run-1");

    expect(run.runId).toBe("run-1");
    expect(run.deploymentId).toBe("restate");
    expect(run.status).toBe("running");
    expect(run.createdAt).toBeInstanceOf(Date);
    expect(run.output).toBeUndefined();
    expect(run.error).toBeUndefined();
  });

  it("get() throws WorkflowRunNotFoundError when null", async () => {
    mockObjectClient.mockReturnValue({
      get: vi.fn().mockResolvedValue(null),
    });

    const world = await getWorld();
    await expect(world.runs.get("nonexistent")).rejects.toThrow();
  });

  it("get() deserializes output for completed runs", async () => {
    mockObjectClient.mockReturnValue({
      get: vi.fn().mockResolvedValue({
        runId: "run-2",
        workflowName: "myWorkflow",
        status: "completed",
        output: { sum: 3 },
        createdAt: 1700000000000,
        completedAt: 1700000001000,
        serviceName: "myWorkflow",
        serializedInput: "[]",
      }),
    });

    const world = await getWorld();
    const run = await world.runs.get("run-2");

    expect(run.status).toBe("completed");
    expect(run.output).toEqual({ sum: 3 });
    expect(run.completedAt).toBeInstanceOf(Date);
  });

  it("get() maps error field", async () => {
    mockObjectClient.mockReturnValue({
      get: vi.fn().mockResolvedValue({
        runId: "run-3",
        workflowName: "myWorkflow",
        status: "failed",
        error: "something broke",
        createdAt: 1700000000000,
        completedAt: 1700000001000,
        serviceName: "myWorkflow",
        serializedInput: "[]",
      }),
    });

    const world = await getWorld();
    const run = await world.runs.get("run-3");

    expect(run.status).toBe("failed");
    expect(run.error).toEqual({ message: "something broke" });
  });

  it("list() throws not implemented", async () => {
    const world = await getWorld();
    expect(() => world.runs.list()).toThrow("not implemented");
  });
});

describe("events.create", () => {
  it("handles run_created — creates run in Restate", async () => {
    const createMock = vi.fn().mockResolvedValue({
      runId: "run-new",
      workflowName: "workflow//src/test.ts//myWorkflow",
      status: "pending",
      createdAt: 1700000000000,
      serviceName: "myWorkflow",
      serializedInput: '["arg1"]',
    });
    mockObjectClient.mockReturnValue({ create: createMock });

    const world = await getWorld();
    const result = await world.events.create("run-new", {
      eventType: "run_created",
      eventData: {
        deploymentId: "restate",
        workflowName: "workflow//src/test.ts//myWorkflow",
        input: ["arg1"],
      },
    });

    expect(createMock).toHaveBeenCalledWith({
      workflowName: "workflow//src/test.ts//myWorkflow",
      serviceName: "myWorkflow",
      input: JSON.stringify(["arg1"]),
    });
    expect(result.run).toBeDefined();
    expect(result.run!.runId).toBe("run-new");
  });

  it("handles hook_received — resolves hook", async () => {
    const resolveMock = vi.fn().mockResolvedValue(undefined);
    mockObjectClient.mockReturnValue({ resolve: resolveMock });

    const world = await getWorld();
    const result = await world.events.create("run-1", {
      eventType: "hook_received",
      correlationId: "my-hook-token",
      eventData: { payload: { approved: true } },
    });

    expect(resolveMock).toHaveBeenCalledWith({ approved: true });
    expect(result).toEqual({});
  });

  it("handles run_cancelled — cancels workflow", async () => {
    const cancelMock = vi.fn().mockResolvedValue({
      runId: "run-cancel",
      workflowName: "myWorkflow",
      status: "cancelled",
      createdAt: 1700000000000,
      completedAt: 1700000001000,
      serviceName: "myWorkflow",
      serializedInput: "[]",
    });
    mockObjectClient.mockReturnValue({ cancel: cancelMock });

    const world = await getWorld();
    const result = await world.events.create("run-cancel", {
      eventType: "run_cancelled",
    });

    expect(cancelMock).toHaveBeenCalled();
    expect(result.run).toBeDefined();
    expect(result.run!.status).toBe("cancelled");
  });

  it("returns {} for run_cancelled when cancel returns null", async () => {
    mockObjectClient.mockReturnValue({
      cancel: vi.fn().mockResolvedValue(null),
    });

    const world = await getWorld();
    const result = await world.events.create("run-1", {
      eventType: "run_cancelled",
    });
    expect(result).toEqual({});
  });

  it("returns {} for unhandled event types", async () => {
    const world = await getWorld();
    const result = await world.events.create("run-1", {
      eventType: "run_started",
    });
    expect(result).toEqual({});
  });

  it("returns {} for step events", async () => {
    const world = await getWorld();
    const result = await world.events.create("run-1", {
      eventType: "step_completed",
      correlationId: "step-1",
      eventData: { result: 42 },
    });
    expect(result).toEqual({});
  });
});

describe("hooks", () => {
  it("get() returns hook data with Date conversion", async () => {
    mockObjectClient.mockReturnValue({
      get: vi.fn().mockResolvedValue({
        runId: "run-1",
        hookId: "hook-1",
        token: "hook-1",
        ownerId: "restate",
        projectId: "restate",
        environment: "development",
        createdAt: 1700000000000,
        isWebhook: false,
        metadata: undefined,
      }),
    });

    const world = await getWorld();
    const hook = await world.hooks.get("hook-1");

    expect(hook.createdAt).toBeInstanceOf(Date);
    expect(hook.runId).toBe("run-1");
    expect(hook.token).toBe("hook-1");
  });

  it("get() throws when hook not found", async () => {
    mockObjectClient.mockReturnValue({
      get: vi.fn().mockResolvedValue(null),
    });

    const world = await getWorld();
    await expect(world.hooks.get("nonexistent")).rejects.toThrow(
      "Hook nonexistent not found"
    );
  });

  it("getByToken() returns hook data", async () => {
    mockObjectClient.mockReturnValue({
      get: vi.fn().mockResolvedValue({
        runId: "run-1",
        hookId: "token-1",
        token: "token-1",
        ownerId: "restate",
        projectId: "restate",
        environment: "development",
        createdAt: 1700000000000,
        isWebhook: true,
        metadata: { key: "value" },
      }),
    });

    const world = await getWorld();
    const hook = await world.hooks.getByToken("token-1");

    expect(hook.isWebhook).toBe(true);
    expect(hook.metadata).toEqual({ key: "value" });
  });

  it("getByToken() throws when hook not found", async () => {
    mockObjectClient.mockReturnValue({
      get: vi.fn().mockResolvedValue(null),
    });

    const world = await getWorld();
    await expect(world.hooks.getByToken("bad")).rejects.toThrow(
      "Hook with token bad not found"
    );
  });
});

describe("streamer stubs", () => {
  it("writeToStream throws not implemented", async () => {
    const world = await getWorld();
    expect(() =>
      world.writeToStream("name", "run-1", "chunk")
    ).toThrow("not implemented");
  });

  it("closeStream throws not implemented", async () => {
    const world = await getWorld();
    expect(() => world.closeStream("name", "run-1")).toThrow(
      "not implemented"
    );
  });

  it("readFromStream throws not implemented", async () => {
    const world = await getWorld();
    expect(() => world.readFromStream("name")).toThrow(
      "not implemented"
    );
  });

  it("listStreamsByRunId throws not implemented", async () => {
    const world = await getWorld();
    expect(() => world.listStreamsByRunId("run-1")).toThrow(
      "not implemented"
    );
  });
});

describe("events stubs", () => {
  it("events.get throws not implemented", async () => {
    const world = await getWorld();
    expect(() =>
      world.events.get("run-1", "event-1")
    ).toThrow("not implemented");
  });

  it("events.list throws not implemented", async () => {
    const world = await getWorld();
    expect(() =>
      world.events.list({ runId: "run-1" })
    ).toThrow("not implemented");
  });

  it("events.listByCorrelationId throws not implemented", async () => {
    const world = await getWorld();
    expect(() =>
      world.events.listByCorrelationId({ correlationId: "c-1" })
    ).toThrow("not implemented");
  });
});

describe("steps stubs", () => {
  it("steps.get throws not implemented", async () => {
    const world = await getWorld();
    expect(() =>
      world.steps.get("run-1", "step-1")
    ).toThrow("not implemented");
  });

  it("steps.list throws not implemented", async () => {
    const world = await getWorld();
    expect(() =>
      world.steps.list({ runId: "run-1" } as never)
    ).toThrow("not implemented");
  });
});
