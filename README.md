# Restate + useworkflow.dev

Use Restate with [useworkflow.dev](http://useworkflow.dev).

> [!IMPORTANT]
> This integration is a proof of concept.

## Quick Start

**Prerequisites:**
- Docker (or OrbStack on Mac) and Docker Compose
- Node.js and `pnpm`
- A Vercel Workflow example to run

### 1. Build the Restate World package

```shell
git clone https://github.com/restatedev/vercel-workflow.git
cd vercel-workflow
pnpm install && pnpm build && pnpm package
```

This creates the `@restatedev/workflow` package that bridges Vercel Workflow to Restate.

### 2. Navigate to the example and run it

```shell
export WORKFLOW_TARGET_WORLD=@restatedev/workflow/world
export RESTATE_INGRESS=http://localhost:8080
export RESTATE_ADMIN_URL=http://localhost:9070
cd packages/examples/workflow 
pnpm run dev
```

### 3. Run Restate Server

```shell
npx @restatedev/restate-server
```

### 4. Register the service

```shell
npx @restatedev/restate deployments register http://localhost:3000/.restate-well-known --use-http1.1
```

### 5. Invoke the service

```shell
  curl -X POST http://localhost:8080/handleUserSignup/run --json '"test@example.com"'   
```

The service logs print the hook token. You can use it to resolve the hook:
```shell
curl -X POST http://localhost:8080/workflowHooks/your-hook-token-123/resolve --json '{"message": "hello"}'
```

## What works

- Plain workflows + steps (`"use workflow"`, `"use step"`).
- `await run.returnValue` / `await run.status` / `run.cancel()`.
- Hooks (`createHook()`, `resumeHook(token, payload)`), including custom/fixed tokens and disposal semantics.
- Webhooks. `createWebhook()` returns a URL pointing directly at Restate's ingress (`${RESTATE_INGRESS}/workflowHooks/<token>/resolve`) — external callers POST to that, the hook signal is delivered to the workflow. No Next.js webhook route in the middle, no extra deployment-URL env var.
- Step retry policy via `stepFn.maxRetries` (plumbed to `ctx.run`'s `maxRetryAttempts`).
- Vercel `FatalError` and `RetryableError` thrown from steps (translated to Restate semantics; `FatalError.is()` works inside the workflow body, `RetryableError`'s `retryAfter` is honored).
- `getWorkflowMetadata()` returns `workflowName` / `workflowRunId` / `workflowStartedAt` / `url` (where `url` is the Restate ingress).
- Cross-VM serialization for primitive args/results; `Response` objects round-tripped through steps.
- `world.runs.list/get` and `world.hooks.list/getByToken` over Restate's admin SQL.

## Known limitations / things that don't work yet

Grouped by area. **Most have a clear workaround** — they're scoped-out, not architectural dead ends.

### Determinism inside the workflow body

- **`Date.now()` is non-deterministic**; inside a workflow body, the clock doesn't advance across `await` boundaries (sleep, hook, step). Vercel solves this by journaling a timestamp on every event-log row and bumping a closure clock as the workflow advances. The equivalent for us is either (a) calling `await ctx.date.now()` at every yield point (lots of extra journal entries), or (b) embedding a timestamp in every primitive's journaled result (cheaper, but touches several files). **Likely direction:** drop `Date.now()` in favour of an async `await date.now()` exported from `workflow`, and either throw on `Date.now()` or wire a logical clock that advances only on `ctx.sleep`. TBD which way to go.
- **`Math.random()` and `crypto.randomUUID()`**; currently use host implementations inside the VM, so values differ on replay. Fix is cheap (delegate to `ctx.rand.random()` / `ctx.rand.uuidv4()`, both sync, both free), just not done yet.
- **`setTimeout` / `setInterval`**; not blocked, will execute as Node defaults. Should throw with a "use `sleep()` from `workflow`" message.

### Webhooks

- **URL shape is Restate-flavoured, not Vercel-flavoured**; `createWebhook()` returns `${RESTATE_INGRESS}/workflowHooks/<token>/resolve` instead of `${appUrl}/.well-known/workflow/v1/webhook/<token>`. Callers POST the body to that URL; the body becomes the value the workflow body sees. This is a deliberate divergence from Vercel's URL contract — see `integration-status.md` for rationale.
- **Manual `respondWith`**; not implemented. `createWebhook({ respondWith: 'manual' })` workflows can't yet return a workflow-computed response. Would need a second awakeable for the response direction.
- **Static `respondWith: Response.json(...)`**; same plumbing, blocked on the same fix.

### Step / class semantics

- **`getStepMetadata()` is not exposed inside step bodies**; upstream's `getStepMetadata()` returns `{ stepName, stepId, stepStartedAt, attempt }` via Node `AsyncLocalStorage`. Wiring this up correctly — in particular making `attempt` increment across retries — requires us to take over retry management from Restate (because Restate's `ctx.run` does its own internal retries but doesn't expose the attempt counter to the closure). We tried that and ended up with a parallel retry loop + tagged-outcome plumbing for one helper, which we decided was too much complexity for v1. If you need per-step metadata, derive it explicitly from step arguments. We use Restate's native `ctx.run` retry policy with `stepFn.maxRetries` honored via `maxRetryAttempts`.
- **`this`-binding on instance-method steps**; lost when calling `stepFn(...args)`. `Counter#add` and friends fail with "Cannot read properties of undefined". Fix is in `createUseStep` (capture `this` in the wrapper, pass via `Function.prototype.call`).
- **Closure variables in step functions**; not transported. A step that captures `multiplier` from outer scope sees `undefined`. Same fix area (capture + inject closure vars).
- **Class instances across the step boundary**; methods lost (`v1.magnitude is not a function`). Requires class-aware (de)serialization, same as Vercel does in its `serialization.ts`.
- **Step function reference as `start()` argument**; `WORKFLOW_USE_STEP not found on global object`. Different code path; needs symbol exposure outside workflow context.

### Streams

- **`world.streams.*`**; `notImplemented`. Affects `readableStreamWorkflow`, the whole `outputStream*` family, and `distributedAbortController` (which depends on streams). Bigger workstream — would need a Restate-backed implementation of writable + readable streams keyed by `(runId, name)`.

### Observability / inspection

- **`world.steps.list/get`**; not implemented. The CLI `workflow inspect steps --runId …` exits 1. Implementation should query `sys_journal WHERE id = <invocationId> AND entry_type = 'Run'`.
- **`world.events.list/get/listByCorrelationId`**; only `events.create` is implemented (used by the runtime). Listing/lookup isn't.
- **Health-check endpoints (`__health` query, queue-based, CLI)**; not implemented. Restate exposes deployment health differently; these need explicit mapping.

### Retry / failure semantics

- **Stack-trace fidelity in step errors**; our stack contains VM artifacts (`evalmachine.<anonymous>`) and lacks the user's step-function name. Upstream's tests assert otherwise. Fix in `ensureHostError` (strip VM frames, preserve user-frame names).
- **`WorkflowNotRegisteredError` / `StepNotRegisteredError`**; wording in our error messages differs from upstream's ("Can't find …" vs "is not registered"). Quick alignment.
- **Resilient start fallback**; when `events.create({run_created})` fails (e.g. 5xx), upstream tests expect the queue path to still create the run. We currently throw.

### Concurrency / parallelism

- **Parallel `ctx.run` / parallel sleeps**; `Promise.all([step(), step()])` runs them through the journal serially. Vercel dispatches step queue messages independently. The equivalent for us is intercepting `Promise.all` in the VM to delegate to `RestatePromise.all` when any argument is a `RestatePromise`. Affects `parallelSleepWorkflow` and other "parallel" tests.

### Recursive workflows

- **`fibonacciWorkflow` (recursive `start()` from inside a workflow)**; returns `null`. Likely an issue with how we serialize the child-run reference.

### Test helpers

- **`run.wakeUp({ correlationIds })`**; upstream uses this to fast-forward pending `sleep()` calls in tests (so a `sleep(10s)` doesn't actually wait 10s). It's technically public API on `Run`, but in practice it's a test-acceleration tool — the upstream e2e suite uses it in `workflow.test.ts`, `cookbook-common.test.ts`, and `cookbook-agents.test.ts`; production user code typically uses a hook instead of a long sleep. We currently support it via a `sleepObj` virtual object that races every `ctx.sleep` against an awakeable keyed by sleep-correlation-id. That's ~50 lines of runtime code and an extra awakeable per sleep, paying ongoing complexity for a test-shaped feature. **Likely direction:** drop `sleepObj`, make `ctx.sleep` a plain `restateCtx.sleep(ms)`, and have `run.wakeUp()` throw `notImplemented`. The affected upstream tests would need to either be skipped or rely on vitest's timeout to bound real sleeps.

### Upstream-only issues (not ours)

- **Pages-router workflows** (`addTenWorkflow via pages router`, etc.); fail with `ERR_MODULE_NOT_FOUND` on upstream's workbench module resolution. Out of our control.

---

See `e2e-reports/run*-summary.md` and `e2e-reports/run*-detailed.md` for the per-test breakdown of where each limitation manifests. `level2-plan.md` has the architectural cleanup we're working toward.