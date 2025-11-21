/* eslint-disable @typescript-eslint/require-await */

import { createHook } from "workflow";

export async function handleUserSignup(email: string) {
  "use workflow";

  await sendWelcomeEmail({ id: "temp-id", email });

  const hook = createHook<{ message: string }>();
  console.log("Hook token:", hook.token);

  const payload = await hook;
  console.log("Received:", payload.message);

  return { userId: "temp-id", status: "onboarded" };
}

async function sendWelcomeEmail(user: { id: string; email: string }) {
  "use step";

  console.log(`Sending welcome email to user: ${user.id}, email ${user.email}`);

  if (Math.random() < 0.7) {
    // By default, steps will be retried for unhandled errors
    throw new Error("Retryable!");
  }
}
