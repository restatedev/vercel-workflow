import { FatalError } from "workflow";

/**
 * Simplest example of a workflow with multiple steps
 */

// Forward steps
async function reserveInventory(orderId: string) {
  "use step";
  // ... call inventory service to reserve ...
  console.log("Reserving inventory for order", orderId);
}
async function chargePayment(orderId: string) {
  "use step";
  // ... charge the customer ...
  console.log("Charging payment for order", orderId);
  throw new FatalError("Payment failed");
}
// Rollback steps
async function releaseInventory(orderId: string) {
  "use step";
  console.log("Releasing inventory for order", orderId);
  // ... undo inventory reservation ...
}
async function refundPayment(orderId: string) {
  "use step";
  console.log("Refunding payment for order", orderId);
  // ... refund the charge ...
}
export async function placeOrderSaga(orderId: string) {
  "use workflow";
  const rollbacks: Array<() => Promise<void>> = [];
  try {
    rollbacks.push(() => releaseInventory(orderId));
    await reserveInventory(orderId);
    rollbacks.push(() => refundPayment(orderId));
    await chargePayment(orderId);
    // ... more steps & rollbacks ...
  } catch (e) {
    for (const rollback of rollbacks.reverse()) {
      await rollback();
    }
    // Rethrow so the workflow records the failure after rollbacks
    throw e;
  }
}
