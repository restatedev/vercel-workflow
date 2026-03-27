import { describe, it, expect } from "vitest";
import {
  WORKFLOW_USE_STEP,
  WORKFLOW_CREATE_HOOK,
  WORKFLOW_SLEEP,
  WORKFLOW_CONTEXT,
  WORKFLOW_GET_STREAM_ID,
  STREAM_NAME_SYMBOL,
  STREAM_TYPE_SYMBOL,
  BODY_INIT_SYMBOL,
  WEBHOOK_RESPONSE_WRITABLE,
} from "./symbols.js";

describe("symbols", () => {
  it("are globally reachable via Symbol.for()", () => {
    expect(WORKFLOW_USE_STEP).toBe(Symbol.for("WORKFLOW_USE_STEP"));
    expect(WORKFLOW_CREATE_HOOK).toBe(Symbol.for("WORKFLOW_CREATE_HOOK"));
    expect(WORKFLOW_SLEEP).toBe(Symbol.for("WORKFLOW_SLEEP"));
    expect(WORKFLOW_CONTEXT).toBe(Symbol.for("WORKFLOW_CONTEXT"));
    expect(WORKFLOW_GET_STREAM_ID).toBe(Symbol.for("WORKFLOW_GET_STREAM_ID"));
    expect(STREAM_NAME_SYMBOL).toBe(Symbol.for("WORKFLOW_STREAM_NAME"));
    expect(STREAM_TYPE_SYMBOL).toBe(Symbol.for("WORKFLOW_STREAM_TYPE"));
    expect(BODY_INIT_SYMBOL).toBe(Symbol.for("BODY_INIT"));
    expect(WEBHOOK_RESPONSE_WRITABLE).toBe(
      Symbol.for("WEBHOOK_RESPONSE_WRITABLE")
    );
  });

  it("are all distinct", () => {
    const symbols = [
      WORKFLOW_USE_STEP,
      WORKFLOW_CREATE_HOOK,
      WORKFLOW_SLEEP,
      WORKFLOW_CONTEXT,
      WORKFLOW_GET_STREAM_ID,
      STREAM_NAME_SYMBOL,
      STREAM_TYPE_SYMBOL,
      BODY_INIT_SYMBOL,
      WEBHOOK_RESPONSE_WRITABLE,
    ];
    const unique = new Set(symbols);
    expect(unique.size).toBe(symbols.length);
  });
});
