/**
 * Two helpers used by example workflows so they can be driven end-to-end
 * without external orchestration. Each example picks whichever is more
 * natural — see comments below.
 */

/**
 * Used by WEBHOOK examples. The /api/mock-callback endpoint schedules a
 * deferred POST to `callbackUrl`. This indirection is needed for manual-
 * response webhooks (m, n): the workflow has to be running its receive loop
 * to call `request.respondWith(...)`, so the inbound POST must happen *after*
 * the workflow body has moved past `await webhook`. A delayed POST gives us that.
 */
export async function registerCallback(
  callbackUrl: string,
  payload: unknown,
  delayMs = 200
): Promise<void> {
  "use step";
  const base = process.env.WORKFLOW_EXAMPLE_BASE_URL ?? "http://localhost:3000";
  await fetch(`${base}/api/mock-callback`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ callbackUrl, payload, delayMs }),
  });
}

/**
 * Used by HOOK examples. The workflow POSTs directly to one of our /api/<x>-resume
 * routes, which calls `resumeHook()`. No deferred dispatch — we don't need it
 * because hooks don't have a back-channel like webhooks do. Restate serializes
 * invocations per virtual-object key, so the underlying `hookObj.create`
 * (sent by createHook) is processed before the resolve call this triggers.
 */
export async function triggerResume(
  routePath: string,
  payload: unknown
): Promise<void> {
  "use step";
  const base = process.env.WORKFLOW_EXAMPLE_BASE_URL ?? "http://localhost:3000";
  await fetch(`${base}/api/${routePath}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}
