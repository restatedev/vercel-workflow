import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { resumeHook, defineHook } from "./index.js";

const originalFetch = globalThis.fetch;
const originalEnv = process.env["RESTATE_INGRESS"];

beforeEach(() => {
  process.env["RESTATE_INGRESS"] = "http://localhost:8080";
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalEnv !== undefined) {
    process.env["RESTATE_INGRESS"] = originalEnv;
  } else {
    delete process.env["RESTATE_INGRESS"];
  }
});

describe("resumeHook", () => {
  it("sends POST to the correct URL with JSON payload", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ invocationId: "inv_123" }),
    });
    globalThis.fetch = mockFetch;

    const result = await resumeHook("my-token", { approved: true });

    expect(mockFetch).toHaveBeenCalledWith(
      "http://localhost:8080/workflowHooks/my-token/resolve",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ approved: true }),
      }
    );
    expect(result).toEqual({ invocationId: "inv_123" });
  });

  it("URL-encodes the token", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ invocationId: "inv_456" }),
    });
    globalThis.fetch = mockFetch;

    await resumeHook("approval:doc-1", { data: "test" });

    const calledUrl = mockFetch.mock.calls[0]![0] as string;
    expect(calledUrl).toBe(
      "http://localhost:8080/workflowHooks/approval%3Adoc-1/resolve"
    );
  });

  it("strips trailing slashes from ingress URL", async () => {
    process.env["RESTATE_INGRESS"] = "http://localhost:8080///";
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ invocationId: "inv_789" }),
    });
    globalThis.fetch = mockFetch;

    await resumeHook("token", "payload");

    const calledUrl = mockFetch.mock.calls[0]![0] as string;
    expect(calledUrl).toBe(
      "http://localhost:8080/workflowHooks/token/resolve"
    );
  });

  it("throws when RESTATE_INGRESS is not set", async () => {
    delete process.env["RESTATE_INGRESS"];
    await expect(resumeHook("token", "payload")).rejects.toThrow(
      "RESTATE_INGRESS"
    );
  });

  it("throws on non-ok response with status and body", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
      statusText: "Not Found",
      text: () => Promise.resolve("hook not found"),
    });
    globalThis.fetch = mockFetch;

    await expect(resumeHook("bad-token", {})).rejects.toThrow(
      "Failed to resume hook (token=bad-token): 404 Not Found - hook not found"
    );
  });
});

describe("defineHook", () => {
  describe("without schema", () => {
    it("create() throws outside workflow context", () => {
      const hook = defineHook<{ approved: boolean }>();
      expect(() => hook.create()).toThrow(
        "can only be called inside a workflow function"
      );
    });

    it("resume() delegates to resumeHook", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ invocationId: "inv_abc" }),
      });
      globalThis.fetch = mockFetch;

      const hook = defineHook<{ approved: boolean }>();
      const result = await hook.resume("my-token", { approved: true });

      expect(result).toEqual({ invocationId: "inv_abc" });
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });
  });

  describe("with schema", () => {
    it("validates and sends transformed value on success", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ invocationId: "inv_def" }),
      });
      globalThis.fetch = mockFetch;

      const schema = {
        "~standard": {
          validate: (value: unknown) => ({
            value: { ...(value as Record<string, unknown>), validated: true },
          }),
        },
      };

      const hook = defineHook({ schema });
      await hook.resume("token", { name: "test" });

      const callArgs = mockFetch.mock.calls[0]![1] as { body: string };
      const body = JSON.parse(callArgs.body) as Record<string, unknown>;
      expect(body).toEqual({ name: "test", validated: true });
    });

    it("throws on validation failure", async () => {
      const schema = {
        "~standard": {
          validate: () => ({
            issues: [{ message: "name is required" }],
          }),
        },
      };

      const hook = defineHook({ schema });
      await expect(hook.resume("token", {})).rejects.toThrow(
        "name is required"
      );
    });

    it("handles async schema validation", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ invocationId: "inv_ghi" }),
      });
      globalThis.fetch = mockFetch;

      const schema = {
        "~standard": {
          validate: (value: unknown) =>
            Promise.resolve({ value: { ...(value as Record<string, unknown>), async: true } }),
        },
      };

      const hook = defineHook({ schema });
      await hook.resume("token", { data: 1 });

      const callArgs = mockFetch.mock.calls[0]![1] as { body: string };
      const body = JSON.parse(callArgs.body) as Record<string, unknown>;
      expect(body).toEqual({ data: 1, async: true });
    });
  });
});
