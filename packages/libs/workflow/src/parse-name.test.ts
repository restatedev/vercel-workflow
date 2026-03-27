import { describe, it, expect } from "vitest";
import { parseWorkflowName, parseStepName } from "./parse-name.js";

describe("parseWorkflowName", () => {
  it("parses a valid workflow name", () => {
    const result = parseWorkflowName(
      "workflow//src/workflows/user-signup.ts//handleSignup"
    );
    expect(result).toEqual({
      shortName: "handleSignup",
      path: "src/workflows/user-signup.ts",
      functionName: "handleSignup",
    });
  });

  it("extracts the last segment as shortName when function name has slashes", () => {
    const result = parseWorkflowName(
      "workflow//src/workflows/nested.ts//sub//deepFn"
    );
    expect(result).toEqual({
      shortName: "deepFn",
      path: "src/workflows/nested.ts",
      functionName: "sub//deepFn",
    });
  });

  it("returns null for a step name", () => {
    expect(
      parseWorkflowName("step//src/workflows/user-signup.ts//sendEmail")
    ).toBeNull();
  });

  it("returns null for an empty string", () => {
    expect(parseWorkflowName("")).toBeNull();
  });

  it("returns null when there is no function name part", () => {
    expect(parseWorkflowName("workflow//path")).toBeNull();
  });

  it("returns null for just the prefix", () => {
    expect(parseWorkflowName("workflow")).toBeNull();
  });
});

describe("parseStepName", () => {
  it("parses a valid step name", () => {
    const result = parseStepName(
      "step//src/workflows/user-signup.ts//sendWelcomeEmail"
    );
    expect(result).toEqual({
      shortName: "sendWelcomeEmail",
      path: "src/workflows/user-signup.ts",
      functionName: "sendWelcomeEmail",
    });
  });

  it("returns null for a workflow name", () => {
    expect(
      parseStepName("workflow//src/workflows/user-signup.ts//handleSignup")
    ).toBeNull();
  });

  it("returns null for an empty string", () => {
    expect(parseStepName("")).toBeNull();
  });
});
