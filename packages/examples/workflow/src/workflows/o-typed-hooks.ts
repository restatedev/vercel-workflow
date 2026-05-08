import { defineHook } from "workflow";
import { z } from "zod";

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

  // Payload is type-safe and validated
  const approval = await hook;

  console.log(
    `Document ${approval.requestId} ${approval.approved ? "approved" : "rejected"}`,
  );
  console.log(`By: ${approval.approvedBy}, Comment: ${approval.comment}`);
}
