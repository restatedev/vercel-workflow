import { describe, it, expect, beforeEach } from "vitest";
import { globalStepRegistry, registerStepFunction } from "./private.js";

describe("globalStepRegistry", () => {
  beforeEach(() => {
    globalStepRegistry.clear();
  });

  it("registers and retrieves a step function", () => {
    const fn = () => "hello";
    registerStepFunction(
      "step//src/workflows/user-signup.ts//sendEmail",
      fn
    );
    expect(
      globalStepRegistry.get("step//src/workflows/user-signup.ts//sendEmail")
    ).toBe(fn);
  });

  it("returns undefined for an unknown key", () => {
    expect(globalStepRegistry.get("step//unknown//fn")).toBeUndefined();
  });

  it("overwrites an existing entry", () => {
    const fn1 = () => "first";
    const fn2 = () => "second";
    const key = "step//src/test.ts//myStep";
    registerStepFunction(key, fn1);
    registerStepFunction(key, fn2);
    expect(globalStepRegistry.get(key)).toBe(fn2);
  });

  it("supports multiple registrations", () => {
    const fn1 = () => 1;
    const fn2 = () => 2;
    registerStepFunction("step//a.ts//step1", fn1);
    registerStepFunction("step//b.ts//step2", fn2);
    expect(globalStepRegistry.get("step//a.ts//step1")).toBe(fn1);
    expect(globalStepRegistry.get("step//b.ts//step2")).toBe(fn2);
  });
});
