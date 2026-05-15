import { getStepMetadata } from "workflow";

// Mock charge provider in place of Stripe so this example runs without setup.
// In production, swap this for the real SDK:
//
//   await stripe.charges.create(
//     { amount, currency: "usd", customer: userId },
//     { idempotencyKey: stepId },
//   );
const chargeProvider = {
  create(
    params: { amount: number; currency: string; customer: string },
    options: { idempotencyKey: string }
  ) {
    console.log("Creating charge", params, "with key", options.idempotencyKey);
    return Promise.resolve({
      id: `ch_${options.idempotencyKey.slice(0, 10)}`,
      ...params,
    });
  },
};

async function chargeUser(userId: string, amount: number) {
  "use step";

  const { stepId } = getStepMetadata();

  // The stepId is unique per step and stable across retries, making it a
  // perfect idempotency key: only one charge is created even if the step
  // retries after a failure.
  return await chargeProvider.create(
    { amount, currency: "usd", customer: userId },
    { idempotencyKey: stepId }
  );
}

export async function idempotentChargeWorkflow(userId: string, amount: number) {
  "use workflow";

  return await chargeUser(userId, amount);
}
