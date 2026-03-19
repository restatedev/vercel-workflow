/* eslint-disable @typescript-eslint/require-await */

import { createHook, FatalError, sleep } from "workflow";

export async function handleUserSignup(email: string) {
  "use workflow";

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

  // Durable hooks
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
    throw new Error("[SIMULATED] Email sending failed!");

    // or throw a fatal error that gets translated to a terminal error
    // throw new FatalError("Simulated error");

  }
}
