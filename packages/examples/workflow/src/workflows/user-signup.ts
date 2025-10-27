/* eslint-disable @typescript-eslint/require-await */
import { createWebhook, getWritable, sleep } from "workflow";
import { FatalError } from "workflow";

export async function handleUserSignup(email: string) {
  "use workflow";

  const user = await createUser(email);

  const writable = getWritable<string>();

  await writeToStream(writable, "starting");

  await sendWelcomeEmail(user);
  await writeToStream(writable, "gonna sleep");
  await sleep("30s");
  await writeToStream(writable, "slept");
  const webhook = createWebhook();
  await sendOnboardingEmail(user, webhook.url);
  await writeToStream(writable, "sent onboarding mail");

  await webhook;
  await writeToStream(writable, "done!");

  await closeStream(writable);

  return { userId: user.id, status: "onboarded" };
}

async function writeToStream(stream: WritableStream<string>, content: string) {
  "use step";

  const writer = stream.getWriter();
  await writer.write(content);
}

async function closeStream(stream: WritableStream<string>) {
  "use step";

  const writer = stream.getWriter();
  await writer.close();
}

async function createUser(email: string) {
  "use step";

  console.log(`Creating user with email: ${email}`);

  return { id: crypto.randomUUID(), email };
}

async function sendWelcomeEmail(user: { id: string; email: string }) {
  "use step";

  console.log(`Sending welcome email to user: ${user.id}`);

  if (Math.random() < 0.3) {
    // By default, steps will be retried for unhandled errors
    throw new Error("Retryable!");
  }
}

async function sendOnboardingEmail(
  user: { id: string; email: string },
  url: string
) {
  "use step";

  if (!user.email.includes("@")) {
    // To skip retrying, throw a FatalError instead
    throw new FatalError("Invalid Email");
  }

  console.log(`Sending onboarding email to user: ${user.id}`);
  console.log(`Complete it with webhook: ${url}`);
}
