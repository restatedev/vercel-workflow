/* eslint-disable @typescript-eslint/require-await */

import { createHook, defineHook, getWorkflowMetadata, sleep } from "workflow";

// Define a typed hook — the same definition is used both inside the workflow
// (.create()) and from API routes (.resume()) for end-to-end type safety.
export const approvalHook = defineHook<{
  approved: boolean;
  comment: string;
}>();

export async function handleSignup(email: string) {
  "use workflow";

  console.info(JSON.stringify(getWorkflowMetadata()))

  // Durable step
  await sendWelcomeEmail({ id: "temp-id", email });

  // Durable fetch — automatically journaled and replayed by Restate
  const res = await fetch("https://jsonplaceholder.typicode.com/users/1");
  const user = (await res.json()) as { name: string };
  console.log("Fetched user:", user.name);

  // Durable sleep; Sleep supports three formats: string, milliseconds, and Date
  await sleep("5s");
  await sleep(3000);
  await sleep(new Date(Date.now() + 2000));

  // Durable hooks — using createHook directly
  const hook = createHook<{ message: string }>();
  console.log("Hook token:", hook.token);
  const payload = await hook;
  console.log("Received:", payload.message);

  // Typed hooks — using defineHook for type-safe creation and resumption
  const approval = approvalHook.create();
  console.log("Approval hook token:", approval.token);
  const approvalResult = await approval;
  console.log("Approved:", approvalResult.approved, "Comment:", approvalResult.comment);

  return { userId: "temp-id", status: "onboarded" };
}

async function sendWelcomeEmail(user: { id: string; email: string }) {
  "use step";

  console.log(`Sending welcome email to user: ${user.id}, email ${user.email}`);

  // console.info(JSON.stringify(getStepMetadata()))

  // if (Math.random() < 0.7) {
  //   // By default, steps will be retried for unhandled errors
  //   throw new Error("[SIMULATED] Email sending failed!");
  //
  //   // or throw a fatal error that gets translated to a terminal error
  //   // throw new FatalError("Simulated error");
  //
  // }
}
