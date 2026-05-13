import { defineHook } from "workflow";
import { z } from "zod";
import { triggerResume } from "./_callback.js";

// Define the hook with a schema for type safety and runtime validation.
// Exported so the API route can call `approvalHook.resume(...)`.
export const approvalHook = defineHook({
  schema: z.object({
    requestId: z.string(),
    approved: z.boolean(),
    approvedBy: z.string(),
    comment: z.string().transform((value) => value.trim()),
  }),
});

export async function documentApprovalWorkflow(documentId: string) {
  "use workflow";

  using hook = approvalHook.create({
    token: `approval:${documentId}`,
  });

  // Simulate the approver service POSTing a typed approval to our resume route.
  await triggerResume("o-resume", {
    documentId,
    requestId: "req-1",
    approved: true,
    approvedBy: "alice",
    comment: "looks good",
  });

  // Payload is type-safe and validated
  const approval = await hook;
  return { documentId, approval };
}
