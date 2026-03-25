# Restate World for Vercel Workflow — Internal Documentation

## Executive Summary

This project (`@restatedev/workflow`) is a **proof-of-concept bridge** between [Vercel Workflow](https://useworkflow.dev) and [Restate](https://restate.dev). It allows developers to write workflows using the Vercel Workflow SDK — with its ergonomic `"use workflow"` and `"use step"` directives — while executing them on top of Restate's durable execution engine.

**The core problem it solves:** Vercel Workflow defines an abstract **World** interface that describes how workflows interact with the outside world (queuing, storage, streaming). By default, Vercel provides its own cloud-hosted World implementation. This project provides an alternative World implementation backed by Restate, giving users Restate's guarantees: automatic retries, durable state, exactly-once execution, and crash recovery — all without changing the workflow code itself.

**High-level architecture:**

```
┌─────────────────────────────────────────────────────────────┐
│  Developer's Workflow Code                                  │
│  (user-signup.ts with "use workflow" / "use step")          │
└──────────────────────┬──────────────────────────────────────┘
                       │
┌──────────────────────▼──────────────────────────────────────┐
│  Vercel Workflow SDK                                        │
│  (start, getRun, workflow bundler, SWC plugin)              │
│  Calls into the World interface for all I/O                 │
└──────────────────────┬──────────────────────────────────────┘
                       │
┌──────────────────────▼──────────────────────────────────────┐
│  @restatedev/workflow  (this project)                       │
│                                                             │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────┐  │
│  │   world.ts   │  │  runtime.ts  │  │    index.ts      │  │
│  │  (World impl)│  │  (Restate    │  │  (Hook API:      │  │
│  │              │  │   services)  │  │   defineHook,    │  │
│  │  Queue,      │  │              │  │   resumeHook)    │  │
│  │  Storage,    │  │  VM sandbox, │  │                  │  │
│  │  Events,     │  │  durable     │  │                  │  │
│  │  Hooks       │  │  primitives  │  │                  │  │
│  └──────┬───────┘  └──────┬───────┘  └──────────────────┘  │
│         │                 │                                  │
└─────────┼─────────────────┼──────────────────────────────────┘
          │                 │
┌─────────▼─────────────────▼──────────────────────────────────┐
│  Restate Server                                              │
│                                                              │
│  - Ingress (HTTP API for invoking services)                  │
│  - Journal (durable execution log, replay on recovery)       │
│  - Virtual Objects (keyed durable state)                     │
│  - Awakeables (external promise resolution)                  │
│  - Admin API (invocation management)                         │
└──────────────────────────────────────────────────────────────┘
```

The project is structured as a pnpm monorepo with a single publishable library (`packages/libs/workflow`) and a Next.js example application (`packages/examples/workflow`).

---

## 1. Architecture Overview

The system has three layers:

### Layer 1: Vercel Workflow SDK (external dependency)

The Vercel Workflow SDK provides:
- **Bundler/SWC plugin**: Transforms `"use workflow"` and `"use step"` functions at build time. The SWC plugin rewrites workflow functions to use injected durable primitives (step, sleep, fetch, createHook) via well-known symbols on `globalThis`. It also registers step functions in a global step registry.
- **`start()`**: Creates a `run_created` event and queues the workflow via the World.
- **`getRun()`**: Returns a handle to query workflow status and results.
- **Serialization**: Vercel uses its own binary serialization format (`dehydrateWorkflowArguments` / `hydrateWorkflowArguments`) for workflow inputs and step outputs.

### Layer 2: @restatedev/workflow (this project)

This is the bridge layer. It has two main parts:

1. **World implementation** (`world.ts`): Implements the Vercel World interface by translating its operations into Restate HTTP calls. When Vercel calls `world.queue()`, the World sends the workflow input to a Restate service. When Vercel calls `world.events.create("hook_received", ...)`, the World resolves the hook via a Restate virtual object.

2. **Runtime** (`runtime.ts`): Defines the Restate services that actually execute workflow code. It creates a Node.js VM sandbox, injects durable primitives (backed by Restate's context), and runs the bundled workflow code inside it.

### Layer 3: Restate Server (external dependency)

Restate provides the execution engine:
- **Services**: Stateless handlers invoked via HTTP. The workflow's `run` handler is a Restate service.
- **Virtual Objects**: Keyed stateful entities. Used for `workflowRunMetadata` (storing run metadata) and `workflowHooks` (managing hook state and subscribers).
- **Journal**: Every side-effecting operation (`ctx.run()`, `ctx.sleep()`, `ctx.awakeable()`) is recorded in Restate's journal. On replay after a crash, completed operations return their stored results without re-executing.
- **Awakeables**: Externally-resolvable promises. Used to implement the hook system — a workflow creates an awakeable and waits, an external caller resolves it.

---

## 2. The World Interface

The Vercel Workflow World interface is the contract between the Workflow SDK and its execution environment. It extends three sub-interfaces:

```typescript
interface World extends Queue, Storage, Streamer {
  start?(): Promise<void>;
  close?(): Promise<void>;
}
```

### Queue

Controls how workflow execution is dispatched:

| Method | Restate Implementation |
|--------|----------------------|
| `getDeploymentId()` | Returns the constant `"restate"` |
| `queue(queueName, message, opts?)` | Sends an HTTP request to `POST {ingress}/{serviceName}/run/send` to start the workflow as a Restate service invocation. Deserializes Vercel's binary input, sends JSON to Restate, stores the resulting `invocationId` mapping. |
| `createQueueHandler()` | Returns a no-op HTTP handler (Restate handles execution directly — no queue polling needed) |

### Storage

Provides access to workflow runs, events, steps, and hooks:

**`runs`**:
- `get(runId)`: Looks up the stored metadata (via `workflowRunMetadata` virtual object) to find the Restate `invocationId`, then queries Restate's invocation output API. Returns a `WorkflowRun` with status derived from the HTTP response: `200` = completed, `470` = still running, other = failed.
- `list()`: Not implemented.

**`events`**:
- `create(runId, data)`: The central dispatch point for workflow lifecycle events. Handles three event types:
  - `run_created`: Caches the serialized input in memory for `queue()` to pick up. Returns a pending WorkflowRun.
  - `hook_received`: Deserializes the payload, then forwards it to the `workflowHooks/{token}/resolve` endpoint on Restate to resolve the hook.
  - `run_cancelled`: Looks up the invocationId and sends a `DELETE` to Restate's admin API to kill the invocation.
- `get()`, `list()`, `listByCorrelationId()`: Not implemented.

**`steps`**: Not implemented (Restate handles step execution internally within the journal).

**`hooks`**:
- `getByToken(token)`: Returns a minimal hook object with the token. This is used by Vercel's `resumeHook` to identify the hook before creating a `hook_received` event. The actual hook state lives in Restate's `workflowHooks` virtual object.
- `get()`, `list()`: Not implemented.

### Streamer

Not implemented. All streaming methods (`writeToStream`, `closeStream`, `readFromStream`, `listStreamsByRunId`) throw "not implemented" errors.

---

## 3. Workflow Lifecycle

Here is the complete lifecycle of a workflow execution, from start to finish:

### Phase 1: Starting a Workflow

```
User                    Next.js API Route          Vercel SDK            Restate World
 │                           │                         │                      │
 │  POST /api/signup         │                         │                      │
 │  { email: "..." }         │                         │                      │
 │──────────────────────────>│                         │                      │
 │                           │  start(handleSignup,    │                      │
 │                           │        [email])          │                      │
 │                           │────────────────────────>│                      │
 │                           │                         │                      │
 │                           │                         │  events.create()     │
 │                           │                         │  eventType:          │
 │                           │                         │  "run_created"       │
 │                           │                         │─────────────────────>│
 │                           │                         │                      │ Cache serialized
 │                           │                         │                      │ input in inputCache
 │                           │                         │  <── pending run ───│
 │                           │                         │                      │
 │                           │                         │  queue(queueName,    │
 │                           │                         │        {runId})      │
 │                           │                         │─────────────────────>│
 │                           │                         │                      │
```

Inside `queue()`:
1. Retrieve the cached serialized input for this `runId`
2. Deserialize it from Vercel's binary format back to raw JavaScript arguments using `hydrateWorkflowArguments()`
3. Extract the Restate service name from the queue name (strip `__wkf_workflow_` prefix, parse the `workflow//path//Name` format)
4. Send `POST {ingress}/{serviceName}/run/send` with the deserialized JSON input
5. Restate returns an `invocationId`
6. Store the `runId → invocationId` mapping durably in the `workflowRunMetadata` virtual object
7. Clean up the transient input cache

### Phase 2: Workflow Execution

Restate invokes the service's `run` handler, which calls `restateHandler()`:

1. **Create VM context**: A new Node.js VM context is created with an isolated `globalThis`
2. **Inject durable primitives**: `useStep`, `createHook`, `sleep`, and `fetch` are created as closures over the Restate context, then injected into the VM via well-known symbols
3. **Execute bundled code**: The SWC-transformed workflow bundle is executed in the VM via `runInContext()`. This populates `globalThis.__private_workflows` with the registered workflow functions
4. **Set workflow context**: The `WORKFLOW_CONTEXT` symbol is set with `workflowRunId`, `workflowName`, `workflowStartedAt`, and `url`
5. **Hydrate input**: The input is deserialized from Vercel's format
6. **Invoke the workflow function**: The actual user function is called with the hydrated arguments
7. **Return value**: The function's return value becomes the invocation result, stored by Restate

### Phase 3: Querying Status

```
User                    Next.js API Route          Vercel SDK            Restate World
 │                           │                         │                      │
 │  GET /api/signup/{runId}  │                         │                      │
 │──────────────────────────>│                         │                      │
 │                           │  getRun(runId)          │                      │
 │                           │────────────────────────>│                      │
 │                           │                         │  runs.get(runId)     │
 │                           │                         │─────────────────────>│
 │                           │                         │                      │
 │                           │                         │                      │ 1. getMetadata(runId)
 │                           │                         │                      │    → workflowRunMetadata
 │                           │                         │                      │      virtual object
 │                           │                         │                      │
 │                           │                         │                      │ 2. GET /restate/invocation/
 │                           │                         │                      │     {invocationId}/output
 │                           │                         │                      │
 │                           │                         │                      │ HTTP 200 → completed
 │                           │                         │                      │ HTTP 470 → still running
 │                           │                         │                      │ Other    → failed
 │                           │                         │                      │
 │                           │  <── WorkflowRun ──────│                      │
```

### Phase 4: Cancellation

```
User                    Next.js API Route          Vercel SDK            Restate World
 │                           │                         │                      │
 │  DELETE /api/signup/{id}  │                         │                      │
 │──────────────────────────>│                         │                      │
 │                           │  run.cancel()           │                      │
 │                           │────────────────────────>│                      │
 │                           │                         │  events.create()     │
 │                           │                         │  eventType:          │
 │                           │                         │  "run_cancelled"     │
 │                           │                         │─────────────────────>│
 │                           │                         │                      │ 1. getMetadata(runId)
 │                           │                         │                      │ 2. DELETE {admin}/
 │                           │                         │                      │    invocations/
 │                           │                         │                      │    {invocationId}
 │                           │                         │                      │
 │                           │  <── cancelled run ────│                      │
```

---

## 4. The Runtime

**File**: `packages/libs/workflow/src/runtime.ts`

The runtime is the Restate-side component. It defines the Restate services and handlers that actually execute workflow code.

### Service Creation

`workflowEntrypoint(workflowCode)` is the main entry point. It creates a Restate endpoint with three components:

1. **The workflow service** — A Restate `service` (stateless) with a single `run` handler
2. **`workflowHooks`** — A Restate `object` (virtual object, keyed by hook token) for managing hooks
3. **`workflowRunMetadata`** — A Restate `object` (virtual object, keyed by runId) for storing run metadata

### VM Sandbox

The workflow code runs in an isolated Node.js VM context (`node:vm`). This is critical because:

- **Isolation**: The workflow code has its own `globalThis`, separate from the host process. This prevents accidental leakage between workflow invocations.
- **Symbol injection**: The Vercel SWC plugin transforms `"use workflow"` functions to read durable primitives from well-known symbols on `globalThis`. The runtime sets these symbols to Restate-backed implementations.
- **Controlled fetch**: The VM's global `fetch` is initially disabled (throws an error), then replaced with the durable version that journals through Restate.

The VM context is set up with:
- `console` → Restate's logging console (integrates with Restate's log system)
- `fetch` → Initially disabled, replaced with `durableFetch` after context creation
- `exports` / `module.exports` → Shim for the CommonJS-style bundle
- `Symbol.for("WORKFLOW_USE_STEP")` → `createUseStep()` closure
- `Symbol.for("WORKFLOW_CREATE_HOOK")` → `createCreateHook()` closure
- `Symbol.for("WORKFLOW_SLEEP")` → `createSleep()` closure
- `Symbol.for("WORKFLOW_CONTEXT")` → Workflow metadata (runId, name, startTime, url)

### Service Name Extraction

The bundled workflow code contains a registration call like:
```javascript
__private_workflows.set("workflow//src/workflows/user-signup.ts//handleSignup", fn)
```

The runtime extracts this string using a regex match on the bundle, then parses it to get the short name (`handleSignup`), which becomes the Restate service name.

### Error Handling

The runtime distinguishes between retryable and fatal errors:

- **Regular errors**: Thrown as-is. Restate will automatically retry the invocation.
- **FatalError**: Vercel Workflow's `FatalError` (detected via duck-typing since it comes from the VM with a different prototype chain) is converted to Restate's `TerminalError`, which tells Restate to stop retrying.

The duck-type check looks for either `{ fatal: true }` or `{ name: "FatalError" }` on the error object, since `instanceof` doesn't work across VM context boundaries.

---

## 5. Durable Primitives

Each durable primitive maps a Vercel Workflow concept to a Restate execution primitive:

### 5.1 Steps (`useStep`)

**Vercel concept**: Functions marked with `"use step"` are side-effecting operations that should be executed durably (with retries on failure).

**Restate mapping**: Each step invocation is wrapped in `ctx.run(stepName, async () => { ... })`. Restate's `ctx.run()` is a journaled side effect — it executes the function, stores the result in the journal, and on replay returns the stored result without re-executing.

**How it works**:
1. The SWC plugin transforms `"use step"` functions and registers them in the `globalStepRegistry` (a global `Map<string, Function>`)
2. When a workflow calls a step function, the transformed code calls `useStep(stepName)` which returns a wrapper function
3. The wrapper looks up the original function in the global registry by its full name (e.g., `"step//src/workflows/user-signup.ts//sendWelcomeEmail"`)
4. It executes the function inside `ctx.run()`, giving it a human-readable name (the short name, e.g., `sendWelcomeEmail`)
5. If the step throws a `FatalError`, it's converted to a `TerminalError`; otherwise Restate retries

### 5.2 Sleep

**Vercel concept**: `sleep()` pauses the workflow for a duration.

**Restate mapping**: `ctx.sleep(millis)` — a durable timer managed by Restate. Survives crashes and restarts.

**Supported formats**:
- `string`: Parsed using the `ms` library (e.g., `"5s"`, `"1m"`, `"2h"`)
- `number`: Milliseconds directly
- `Date`: Computes the difference from `Date.now()`. Uses duck-type checking (`typeof param.getTime === "function"`) because VM Date objects have a different prototype than host Date objects.

### 5.3 Durable Fetch

**Vercel concept**: `fetch()` inside a workflow should be durable — the response should be recorded and replayed on recovery.

**Restate mapping**: The fetch is wrapped in `ctx.run("fetch {url}", async () => { ... })`:
1. Execute the real `fetch()` call
2. Serialize the response into a plain object: `{ status, statusText, headers, body, url }`
3. Return the serialized response (stored in Restate's journal)
4. Reconstruct a `Response` object from the serialized data

This means the actual HTTP call only happens once. On replay, the stored serialized response is used to construct a new `Response` object.

### 5.4 Hooks (createHook)

**Vercel concept**: `createHook()` creates an external waiting point — the workflow pauses until an external caller sends data to the hook's token.

**Restate mapping**: Uses Restate's **awakeables** — externally-resolvable promises:
1. `ctx.awakeable()` creates a durable promise and returns `{ id, promise }`
2. The hook's token is either provided explicitly or generated via `ctx.rand.uuidv4()` (deterministic random for replay safety)
3. The awakeable ID is registered with the `workflowHooks` virtual object
4. The workflow awaits the promise
5. An external caller resolves the hook by calling the virtual object's `resolve` handler

See section 6 for the full hooks deep-dive.

---

## 6. Hooks System (Deep Dive)

The hooks system is the most complex part of the bridge. It enables workflows to pause and wait for external input.

### Two Levels of Hook API

**1. Untyped hooks (`createHook<T>()`)**:
- Called inside a workflow function
- Returns a `Hook<T>` object that is:
  - **Thenable** (has a `.then()` method, so you can `await` it)
  - **AsyncIterable** (supports `for await (const payload of hook) { ... }`)
  - **Disposable** (has `.dispose()` and `[Symbol.dispose]()`)
- The hook's `.token` property is used by external callers to resume it

**2. Typed hooks (`defineHook<TInput, TOutput>()`)**:
- Defined at module level (outside workflow functions)
- Returns a `TypedHook` object with two methods:
  - `.create(options?)`: Called inside a workflow — creates the hook (delegates to `createHook`)
  - `.resume(token, payload)`: Called from API routes — sends payload to the hook
- Supports optional schema validation via Standard Schema v1 (Zod, Valibot, ArkType)
- The `create()` method throws if called outside a workflow (it's replaced by the runtime at execution time)

### The `workflowHooks` Virtual Object

This is a Restate virtual object keyed by hook token. It has three handlers:

**`createAndSubscribe`**: Called when a workflow creates a hook.
- Input: `{ invocationId, awakeableId }`
- If the hook has already been resolved (result exists in state), immediately resolves the awakeable
- Otherwise, stores the metadata and adds the awakeable to the subscribers list

**`resolve`**: Called when an external caller resumes a hook.
- Input: the payload
- Stores the result in state
- Resolves ALL subscriber awakeables with the result
- Clears the subscriber list
- Returns the hook metadata (invocationId)

**`dispose`**: Called when a hook is no longer needed.
- Clears all state for this hook token

### Hook Resolution Flow

```
Workflow Code              workflowHooks/{token}        External Caller
     │                          (Virtual Object)              │
     │                               │                        │
     │  1. ctx.awakeable()           │                        │
     │     → {id, promise}           │                        │
     │                               │                        │
     │  2. createAndSubscribe({      │                        │
     │       invocationId,           │                        │
     │       awakeableId: id         │                        │
     │     })                        │                        │
     │──────────────────────────────>│                        │
     │                               │  Store subscriber      │
     │                               │                        │
     │  3. await promise             │                        │
     │     (workflow suspends)       │                        │
     │                               │                        │
     │                               │  4. resolve(payload)   │
     │                               │<───────────────────────│
     │                               │                        │
     │                               │  resolveAwakeable(     │
     │                               │    awakeableId,        │
     │                               │    payload             │
     │  5. promise resolves          │  )                     │
     │     with payload              │                        │
     │<──────────────────────────────│                        │
     │                               │                        │
     │  6. Workflow continues         │                        │
```

### Key Design Decisions

- **Multiple subscribers**: The virtual object maintains a list of subscribers, not just one. This allows multiple parties to wait on the same hook token (though in practice it's typically one).
- **Late resolution**: If `resolve` is called before `createAndSubscribe`, the result is stored. When `createAndSubscribe` is called later, it finds the result and immediately resolves the awakeable. This handles race conditions.
- **Deterministic tokens**: Hook tokens can be explicitly provided (`options.token`) or generated via `ctx.rand.uuidv4()`, which is deterministic during replay.

### Hook Resumption Paths

There are two ways to resume a hook from outside:

**Path 1: Direct Restate call** (`resumeHook` from `index.ts`):
```
POST {ingress}/workflowHooks/{token}/resolve
Body: JSON payload
```
This goes directly to the Restate virtual object. Used by `defineHook().resume()` and `resumeHook()`.

**Path 2: Via Vercel's event system** (`events.create` with `hook_received`):
```
events.create(runId, { eventType: "hook_received", correlationId: token, eventData: { payload } })
```
This deserializes the payload from Vercel's format and then calls the same Restate endpoint. Used internally by the Vercel SDK when hooks are resumed through its API.

---

## 7. Metadata Management

### The `workflowRunMetadata` Virtual Object

**File**: `packages/libs/workflow/src/runtime.ts` (lines 59-88)

This Restate virtual object is keyed by Vercel's `runId` and stores:

```typescript
type RunMetadataState = {
  workflowName: string;    // e.g., "handleSignup"
  invocationId: string;    // Restate's invocation ID
  createdAt: number;       // Timestamp (epoch ms)
};
```

**Handlers**:
- `store(input)`: Saves the workflow name, invocation ID, and current timestamp
- `get()`: Returns the stored metadata (or null if not found)

### Why This Exists

Vercel Workflow uses its own `runId` to identify workflow executions. Restate uses its own `invocationId`. The metadata virtual object provides the durable mapping between these two identifiers.

This mapping is needed for:
1. **Status queries**: `runs.get(runId)` → look up `invocationId` → query Restate's invocation output API
2. **Cancellation**: `run_cancelled` event → look up `invocationId` → `DELETE` via Restate admin API

### Status Derivation

When `runs.get(runId)` is called, the World queries:
```
GET {ingress}/restate/invocation/{invocationId}/output
```

The HTTP response code determines status:
- `200 OK`: Workflow completed successfully. Response body is the output.
- `470`: Workflow is still running (Restate-specific status code).
- Any other status: Workflow failed. Response body contains the error message.

---

## 8. Serialization Bridge

Vercel Workflow uses its own binary serialization format for workflow inputs and step outputs. Restate uses JSON. The bridge must translate between them.

### Where Translation Happens

**1. In `world.ts` — `queue()` method** (workflow input):
```typescript
const rawArgs = await serialization.hydrateWorkflowArguments(
  cachedInput,        // Vercel's serialized binary format
  payload.runId,
  undefined,
  globalThis
);
// rawArgs is now a plain JavaScript array, sent as JSON to Restate
```

**2. In `world.ts` — `events.create()` for `hook_received`** (hook payload):
```typescript
const rawPayload = await serialization.hydrateStepArguments(
  eventData.eventData.payload,   // Vercel's serialized format
  runId,
  undefined
);
// rawPayload is now plain JavaScript, sent as JSON to Restate
```

**3. In `runtime.ts` — `restateHandler()`** (workflow input on Restate side):
```typescript
const hydrated = await serialization.hydrateWorkflowArguments(
  [input],                // Input received as JSON from Restate
  restateCtx.request().id,
  undefined,
  vmGlobalThis
);
```

### The Input Cache

There's an in-memory `Map<string, any[]>` called `inputCache` in `world.ts`. This exists because Vercel's `start()` flow is two-phase:

1. First, `events.create()` is called with `run_created` — the serialized input is available here
2. Then, `queue()` is called — it needs the input to send to Restate

The input cache bridges this gap. It's **not durable** — it only needs to survive within a single `start()` call, which is synchronous from the World's perspective.

---

## 9. The Step Registry

**File**: `packages/libs/workflow/src/internal/private.ts`

```typescript
export const globalStepRegistry = new Map<string, (...args: unknown[]) => unknown>();
```

### How Steps Get Registered

1. The Vercel SWC plugin transforms functions marked with `"use step"` at build time
2. The transformed code imports `registerStepFunction` from `@restatedev/workflow/internal/private` (aliased from `workflow/internal/private` via Turbopack config)
3. At module load time, the step function is registered with its full entity ID:
   ```
   registerStepFunction("step//src/workflows/user-signup.ts//sendWelcomeEmail", fn)
   ```

### How Steps Are Looked Up

When a workflow calls a step function:
1. The SWC-transformed code calls `useStep("step//src/workflows/user-signup.ts//sendWelcomeEmail")`
2. `useStep` looks up the function in `globalStepRegistry`
3. If found, wraps it in `ctx.run(shortName, fn)` for durable execution
4. If not found, throws an error listing all available steps

### Why It's Global

The step registry is a module-level global because step functions are registered at module load time (when the bundle is evaluated), before any workflow execution begins. The registry is shared across all workflow invocations within the same process.

---

## 10. Name Parsing

**File**: `packages/libs/workflow/src/parse-name.ts`

The Vercel SWC plugin generates structured names for workflows and steps:

```
workflow//src/workflows/user-signup.ts//handleSignup
step//src/workflows/user-signup.ts//sendWelcomeEmail
```

Format: `{tag}//{filePath}//{functionName}`

The `parseName()` function splits on `//` and extracts:
- `shortName`: The last segment (e.g., `handleSignup`) — used as the Restate service name and journal entry labels
- `path`: The file path (e.g., `src/workflows/user-signup.ts`)
- `functionName`: Everything after the path (usually the same as shortName, but could contain nested `//` segments)

This is used in:
- `extractServiceName()` in `runtime.ts` to determine the Restate service name
- `workflowNameFromQueue()` in `world.ts` to map queue names to service names
- `createUseStep()` in `runtime.ts` to give journal entries readable names

---

## 11. Symbols

**File**: `packages/libs/workflow/src/symbols.ts`

The Vercel SWC plugin transforms workflow code to access durable primitives via well-known symbols on `globalThis`. These symbols are the contract between the SWC plugin (which generates code referencing them) and the runtime (which sets them):

| Symbol | Purpose | Set To |
|--------|---------|--------|
| `WORKFLOW_USE_STEP` | Durable step execution | `createUseStep()` — wraps functions in `ctx.run()` |
| `WORKFLOW_CREATE_HOOK` | Hook creation | `createCreateHook()` — creates awakeables |
| `WORKFLOW_SLEEP` | Durable timer | `createSleep()` — delegates to `ctx.sleep()` |
| `WORKFLOW_CONTEXT` | Workflow metadata | Object with `workflowRunId`, `workflowName`, `workflowStartedAt`, `url` |
| `WORKFLOW_GET_STREAM_ID` | Stream identification | Not implemented |
| `STREAM_NAME_SYMBOL` | Stream naming | Not implemented |
| `STREAM_TYPE_SYMBOL` | Stream typing | Not implemented |
| `BODY_INIT_SYMBOL` | Body initialization | Not implemented |
| `WEBHOOK_RESPONSE_WRITABLE` | Webhook response | Not implemented |

The symbols use `Symbol.for()` (global symbol registry) so they're accessible across module boundaries and even across the VM context boundary.

---

## 12. Configuration & Environment

### Environment Variables

| Variable | Required | Purpose |
|----------|----------|---------|
| `RESTATE_INGRESS` | Yes | Restate ingress URL (e.g., `http://localhost:8080`). Used for service invocation, hook resolution, and status queries. |
| `RESTATE_ADMIN_URL` | Yes (for cancellation) | Restate admin API URL (e.g., `http://localhost:9070`). Used only for cancelling invocations. |
| `RESTATE_LOGGING` | No | Logging level (e.g., `debug`). Passed to the Restate SDK. |

### Next.js Configuration

**File**: `packages/examples/workflow/next.config.ts`

```typescript
const nextConfig: NextConfig = {
  turbopack: {
    resolveAlias: {
      "workflow/runtime": "@restatedev/workflow/runtime",
      "workflow/internal/private": "@restatedev/workflow/internal/private",
    },
  },
};
export default withWorkflow(nextConfig);
```

- `withWorkflow()`: Vercel's Next.js plugin that sets up the workflow bundler/SWC transformation
- `resolveAlias`: Redirects the Vercel-standard import paths (`workflow/runtime`, `workflow/internal/private`) to the Restate implementations (`@restatedev/workflow/runtime`, `@restatedev/workflow/internal/private`)

This is the key wiring point — it tells the Vercel workflow bundler to use Restate's runtime and step registry instead of Vercel's defaults.

### Restate Well-Known Endpoint

**File**: `packages/examples/workflow/src/app/.restate-well-known/[[...slug]]/route.js`

This Next.js route serves as the Restate service discovery endpoint. It:
1. Imports the step registration side-effect (ensuring steps are registered in the global registry)
2. Re-exports the workflow handler from Vercel's well-known route
3. Serves at `/.restate-well-known` — this is the URL you register with Restate: `restate deployments register http://localhost:3000/.restate-well-known`

---

## 13. Example Walkthrough: User Signup

Let's trace a complete execution of the user-signup workflow.

### Workflow Code

```typescript
// user-signup.ts
export const approvalHook = defineHook<{ approved: boolean; comment: string }>();

export async function handleSignup(email: string) {
  "use workflow";

  // Step 1: Send welcome email (durable step)
  await sendWelcomeEmail({ id: "temp-id", email });

  // Step 2: Fetch external data (durable fetch)
  const res = await fetch("https://jsonplaceholder.typicode.com/users/1");
  const user = await res.json();

  // Step 3: Wait (durable sleep, three formats)
  await sleep("5s");
  await sleep(3000);
  await sleep(new Date(Date.now() + 2000));

  // Step 4: Wait for untyped hook
  const hook = createHook<{ message: string }>();
  const payload = await hook;

  // Step 5: Wait for typed hook
  const approval = approvalHook.create();
  const result = await approval;

  return { userId: "temp-id", status: "onboarded" };
}
```

### End-to-End Trace

**1. Start the workflow:**
```
POST http://localhost:3000/api/signup
Body: { "email": "test@example.com" }
```

- `route.ts` calls `start(handleSignup, ["test@example.com"])`
- Vercel SDK calls `world.events.create(runId, { eventType: "run_created", eventData: { workflowName: "handleSignup", input: [serializedEmail] } })`
- World caches the serialized input
- Vercel SDK calls `world.queue("__wkf_workflow_workflow//src/workflows/user-signup.ts//handleSignup", { runId })`
- World deserializes the input, sends `POST http://localhost:8080/handleSignup/run/send` with `"test@example.com"`
- Restate returns `{ invocationId: "..." }`
- World stores metadata durably
- Returns `{ runId: "..." }` to the user

**2. Restate executes the workflow:**
- Restate invokes the `handleSignup` service's `run` handler
- Runtime creates VM, injects primitives, runs bundle
- **sendWelcomeEmail**: Wrapped in `ctx.run("sendWelcomeEmail", ...)` — logged in journal
- **fetch**: Wrapped in `ctx.run("fetch https://...", ...)` — HTTP call made, response serialized and journaled
- **sleep("5s")**: `ctx.sleep(5000)` — Restate timer set, workflow suspends
- After 5s: **sleep(3000)**: `ctx.sleep(3000)` — another timer
- After 3s: **sleep(Date)**: `ctx.sleep(2000)` — another timer
- After 2s: **createHook**: `ctx.awakeable()` + register with `workflowHooks/{token}` — workflow suspends

**3. Resume untyped hook:**
```
POST http://localhost:8080/workflowHooks/{token}/resolve
Body: { "message": "hello" }
```
- Virtual object resolves the awakeable
- Workflow wakes up, receives `{ message: "hello" }`
- Creates approval hook — workflow suspends again

**4. Resume typed hook:**
```
PUT http://localhost:3000/api/approval
Body: { "token": "...", "approved": true, "comment": "Looks good" }
```
- API route calls `approvalHook.resume(token, { approved: true, comment: "Looks good" })`
- `resumeHook` sends `POST http://localhost:8080/workflowHooks/{token}/resolve`
- Virtual object resolves the awakeable
- Workflow wakes up, receives `{ approved: true, comment: "Looks good" }`

**5. Workflow completes:**
- Returns `{ userId: "temp-id", status: "onboarded" }`
- Restate stores the result

**6. Query result:**
```
GET http://localhost:3000/api/signup/{runId}
```
- World looks up metadata → gets invocationId
- Queries `GET http://localhost:8080/restate/invocation/{invocationId}/output`
- Gets `200 OK` with `{ userId: "temp-id", status: "onboarded" }`
- Returns `{ status: "completed", result: { userId: "temp-id", status: "onboarded" } }`

---

## 14. What's Not Implemented

The following World interface methods are stubbed and throw "not implemented" errors:

| Category | Method | Notes |
|----------|--------|-------|
| Storage: runs | `list()` | Would need to enumerate Restate invocations |
| Storage: events | `get()`, `list()`, `listByCorrelationId()` | Event sourcing is handled internally by Restate's journal |
| Storage: steps | `get()`, `list()` | Step state is tracked in Restate's journal |
| Storage: hooks | `get()`, `list()` | Only `getByToken()` is implemented |
| Streaming | `writeToStream()`, `closeStream()`, `readFromStream()`, `listStreamsByRunId()` | Streaming/SSE support not yet built |

Additionally:
- The status SSE endpoint (`/api/signup/[runId]/status/route.ts`) is a TODO
- The `stepEntrypoint()` function in `runtime.ts` is empty (steps run inline within the workflow service)
- `writeToStreamMulti()` from the Streamer interface is not implemented
