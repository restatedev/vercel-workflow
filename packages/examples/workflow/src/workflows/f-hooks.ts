import { createHook } from "workflow";

export async function approvalWorkflow() {
  "use workflow";
  using hook = createHook<{ approved: boolean; comment: string }>();
  console.log("Waiting for approval...");
  console.log("Send approval to token:", hook.token);
  // Workflow pauses here until data is sent
  const result = await hook;
  if (result.approved) {
    console.log("Approved with comment:", result.comment);
  } else {
    console.log("Rejected:", result.comment);
  }
}