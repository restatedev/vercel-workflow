# Restate World for Vercel Workflow — Internal Documentation

## Overview

This project (`@restatedev/workflow`) bridges [Vercel Workflow](https://useworkflow.dev) and [Restate](https://restate.dev). Developers write workflows using the Vercel Workflow SDK (`"use workflow"` / `"use step"` directives) while executing them on Restate's durable execution engine.

Vercel Workflow defines an abstract **World** interface for workflow I/O (queuing, storage, streaming). This project provides a Restate-backed World implementation, plus a set of **API overrides** (`@restatedev/workflow/api`) that replace parts of the Vercel SDK with Restate-native behavior where the default implementation is suboptimal.

### Project Structure

```
packages/libs/workflow/src/
├── api.ts          # Restate-native Run class (overrides start, getRun, returnValue, wakeUp)
├── index.ts        # Hook API (resumeHook, defineHook)
├── runtime.ts      # Restate services: workflowRun, workflowSleep, workflowHooks, workflow executor
├── world.ts        # World interface implementation
└── symbols.ts      # Well-known symbols for VM injection

packages/examples/workflow/
├── next.config.ts  # Turbopack aliases (workflow/api → @restatedev/workflow/api, etc.)
└── src/workflows/  # Example workflow functions
```

### High-Level Architecture

```
┌──────────────────────────────────────────────────────┐
│  Developer's Workflow Code                            │
│  ("use workflow" / "use step" / sleep / createHook)   │
└─────────────────────┬────────────────────────────────┘
                      │
┌─────────────────────▼────────────────────────────────┐
│  Vercel Workflow SDK (bundler, SWC plugin, start())   │
│  Calls the World interface for lifecycle events        │
└─────────────────────┬────────────────────────────────┘
                      │
┌─────────────────────▼────────────────────────────────┐
│  @restatedev/workflow                                 │
│                                                       │
│  ┌─────────────┐ ┌───────────┐ ┌──────────────────┐  │
│  │  world.ts   │ │ runtime.ts│ │     api.ts       │  │
│  │  (World     │ │ (Restate  │ │  (Run subclass,  │  │
│  │   impl)     │ │  services │ │   start/getRun   │  │
│  │             │ │  + VM     │ │   overrides)     │  │
│  │  Events,    │ │  sandbox) │ │                  │  │
│  │  Queue,     │ │           │ │  wakeUp → direct │  │
│  │  Runs       │ │           │ │  returnValue →   │  │
│  │             │ │           │ │    attach        │  │
│  └──────┬──────┘ └─────┬────┘ └────────┬─────────┘  │
│         │              │               │              │
└─────────┼──────────────┼───────────────┼──────────────┘
          │              │               │
┌─────────▼──────────────▼───────────────▼──────────────┐
│  Restate Server                                        │
│  Virtual Objects, Awakeables, Durable Timers, Journal  │
└────────────────────────────────────────────────────────┘
```

---

## Why We Override `workflow/api`

The Vercel SDK's `Run` class (from `@workflow/core`) is designed for Vercel's event-sourcing model. Several of its methods don't map well to Restate:

| Method | Vercel SDK behavior | Problem | Our override |
|--------|-------------------|---------|-------------|
| `returnValue` | Polls `world.runs.get()` every 1 second in a loop | Wasteful; Restate can block efficiently | Uses `ctx.attach()` on the workflow invocation — one request, no polling |
| `wakeUp()` | Calls `wakeUpRun()` which pages through `events.list` to find pending sleeps, then creates `wait_completed` events | Requires implementing Vercel's full event log; conceptually wrong for Restate | Calls `sleepObj.getPending()` then `sleepObj.wakeUp()` directly |
| `cancel()` | Creates a `run_cancelled` event via `world.events.create()` | Works fine through our World | Inherited from base class (no override needed) |

The override is wired via **turbopack aliases** in `next.config.ts`:

```typescript
turbopack: {
  resolveAlias: {
    "workflow/api": "@restatedev/workflow/api",          // Our Run, start, getRun
    "workflow/runtime": "@restatedev/workflow/runtime",   // Our Restate services
    "workflow/internal/private": "@restatedev/workflow/internal/private",
  },
}
```

When the app imports `{ start, getRun } from "workflow/api"`, it gets our versions which return a `Run` subclass with Restate-native `wakeUp()` and `returnValue`.

---

## Virtual Objects

The runtime defines three Restate virtual objects:

### `workflowRun` (keyed by runId)

Manages the lifecycle of a single workflow run.

**State**: `{ data: WorkflowRunData }` where `WorkflowRunData` contains `runId`, `workflowName`, `status`, `output`, `error`, `createdAt`, `completedAt`, `serviceName`, `serializedInput`, `invocationId`.

| Handler | Type | Purpose |
|---------|------|---------|
| `create` | exclusive | Stores initial run metadata (status: "pending") |
| `submit` | exclusive | Dispatches the workflow via `genericSend`, stores invocationId, awaits completion via `ctx.attach()`, updates status to completed/failed/cancelled |
| `get` | shared | Returns current run data |
| `awaitResult` | shared | Blocks until the workflow completes using `ctx.attach()` on the invocation. Handles the create→submit race by polling while status is "pending". |
| `cancel` | shared | Cancels the invocation via `ctx.cancel()`, waits for submit to update status |

### `workflowSleep` (keyed by runId)

Tracks pending sleeps for a workflow run so `wakeUp()` can find and resolve them.

**State**: `{ pending: SleepEntry[] }` where `SleepEntry = { awakeableId }`.

| Handler | Type | Purpose |
|---------|------|---------|
| `register` | exclusive | Adds a sleep entry to the pending list |
| `complete` | exclusive | Removes a sleep entry (called after the race resolves) |
| `wakeUp` | exclusive | Resolves the awakeable for a given awakeableId, removes entry |
| `getPending` | shared | Returns the pending list (used by `Run.wakeUp()` to discover sleeps) |

### `workflowHooks` (keyed by hook token)

Manages hook lifecycle. A hook is an external waiting point — the workflow pauses until someone sends data to the hook's token.

**State**: `{ awakeableId, runId, createdAt, invocationId }` — flat fields, no nested objects.

| Handler | Type | Purpose |
|---------|------|---------|
| `create` | exclusive | Stores the awakeable ID. Rejects duplicate tokens (409) while a previous hook is active. |
| `resolve` | exclusive | Resolves the awakeable with the payload. Returns `{ invocationId }`. |
| `get` | shared | Reconstructs hook metadata from stored fields + `ctx.key` |
| `dispose` | exclusive | Clears all state |

---

## Durable Primitives

Each Vercel Workflow primitive maps to a Restate execution primitive. These are injected into the workflow VM via well-known symbols on `globalThis`.

### Steps (`useStep`)

`"use step"` functions → `ctx.run(stepName, fn)`.

Restate's `ctx.run()` is a journaled side effect: execute once, store the result, replay from the journal on recovery. Steps are looked up in the `globalStepRegistry` (a `Map<string, Function>` populated by the SWC plugin at bundle-load time).

### Sleep

`sleep(duration)` → `RestatePromise.race([ctx.sleep(millis), awakeable])`.

Each sleep creates both a durable timer and an awakeable, then races them. The awakeable is registered in the `workflowSleep` virtual object so that `wakeUp()` can resolve it to end the sleep early. The awakeable ID itself serves as the unique identifier for each sleep — no separate correlation ID is needed.

On completion (either timer or wakeUp), a fire-and-forget `complete` call removes the entry from the virtual object.

**Duration parsing**: Supports `number` (ms), `string` (parsed by the `ms` library: `"5s"`, `"1h"`, `"24h"`), and `Date` (duck-typed via `.getTime()` because VM Date objects have a different prototype).

### Durable Fetch

`fetch(url)` → `ctx.run("fetch {url}", async () => { ... })`.

The real HTTP call executes inside a journaled side effect. The response is serialized to `{ status, statusText, headers, body, url }` and stored in the journal. On replay, a `Response` object is reconstructed from the stored data.

### Hooks (`createHook`)

`createHook()` → `ctx.awakeable()` + registration in the `workflowHooks` virtual object.

1. Creates an awakeable: `{ id, promise }`
2. Token is either user-provided (`options.token`) or defaults to the awakeable ID
3. Registers with `workflowHooks/{token}` via fire-and-forget `create` call
4. Returns a `Hook<T>` object that is thenable (awaitable), disposable, and async-iterable
5. External caller resolves via `resumeHook(token, payload)` → `POST /workflowHooks/{token}/resolve`

**Typed hooks** (`defineHook<TInput, TOutput>()`): Module-level helper that provides type-safe `create()` and `resume()` methods with optional schema validation (Standard Schema v1: Zod, Valibot, ArkType).

---

## World Implementation

**File**: `world.ts`

The World is the bridge between the Vercel SDK's lifecycle events and Restate's virtual objects. It implements the Vercel `World` interface.

### Queue

| Method | Implementation |
|--------|---------------|
| `getDeploymentId()` | Returns `"restate"` |
| `queue()` | Sends `workflowRun/{runId}/submit` via `objectSendClient` (fire-and-forget) |
| `createQueueHandler()` | No-op (Restate handles execution directly) |

### Events

`events.create()` is the central dispatch for lifecycle events:

| Event Type | Action |
|-----------|--------|
| `run_created` | Deserializes Vercel's binary input, creates `workflowRun/{runId}` via `create` handler |
| `hook_received` | Deserializes payload, calls `workflowHooks/{token}/resolve` |
| `run_cancelled` | Calls `workflowRun/{runId}/cancel` |

### Runs

| Method | Implementation |
|--------|---------------|
| `runs.get(id)` | Queries `workflowRun/{id}/get`, converts to Vercel's `WorkflowRun` format |

### Hooks

| Method | Implementation |
|--------|---------------|
| `hooks.get(id)` | Queries `workflowHooks/{id}/get` |
| `hooks.getByToken(token)` | Same as `get` (token = virtual object key) |

---

## Workflow Lifecycle

### Starting a Workflow

1. User calls `start(workflow, args)` (our override in `api.ts`)
2. This delegates to `@workflow/core`'s `start()` which calls `world.events.create("run_created", ...)`
3. `world.ts` deserializes the input and creates the `workflowRun` virtual object
4. `@workflow/core` calls `world.queue()` which sends `submit` to the virtual object
5. `submit` dispatches the workflow service via `genericSend`, stores the invocationId, and awaits completion via `ctx.attach()`
6. Our `start()` wraps the result in our `Run` subclass and returns it

### Executing a Workflow

1. Restate invokes the workflow service's `run` handler → `restateHandler()`
2. A Node.js VM sandbox is created with an isolated `globalThis`
3. Durable primitives are injected via well-known symbols: `useStep`, `createHook`, `sleep`, `fetch`
4. The bundled workflow code is executed in the VM, populating `globalThis.__private_workflows`
5. The user's workflow function is invoked with deserialized arguments
6. The return value becomes the Restate invocation result

### Awaiting Results

1. User accesses `run.returnValue` (our override)
2. Calls `workflowRun/{runId}/awaitResult` — a shared handler that uses `ctx.attach()` to block until the workflow invocation finishes
3. Returns the final `WorkflowRunData` with output/error/status
4. One request, no polling

### Waking Up Sleeps

1. User calls `run.wakeUp(options?)` (our override)
2. Calls `workflowSleep/{runId}/getPending` to discover registered sleeps
3. Optionally filters by `awakeableIds`
4. For each target: calls `workflowSleep/{runId}/wakeUp({ awakeableId })`
5. The handler resolves the awakeable, which wins the `RestatePromise.race` in the sleeping workflow
6. The workflow continues past the `sleep()` call

### Resuming Hooks

1. External caller calls `resumeHook(token, payload)` or `typedHook.resume(token, payload)`
2. Sends `POST {ingress}/workflowHooks/{token}/resolve` with the payload
3. The handler resolves the awakeable, workflow resumes with the payload

### Cancelling

1. User calls `run.cancel()` (inherited from base `Run` class)
2. Creates a `run_cancelled` event → `world.events.create()`
3. `world.ts` calls `workflowRun/{runId}/cancel`
4. The cancel handler calls `ctx.cancel(invocationId)`, waits for submit to update status

---

## VM Sandbox Details

Workflow code runs in an isolated `node:vm` context. Key setup:

- `console` → Restate's logging console
- `fetch` → Initially disabled, replaced with durable fetch
- `exports` / `module.exports` → CommonJS shim for the bundle
- `Symbol.dispose` / `Symbol.asyncDispose` → Polyfilled for `using` keyword support
- Well-known symbols → Durable primitives (`useStep`, `createHook`, `sleep`)
- `WORKFLOW_CONTEXT` → `{ workflowRunId, workflowName, workflowStartedAt, url }`

**Cross-VM gotchas**:
- `instanceof Date` / `instanceof Error` fail across VM boundaries (different prototypes) → duck-type checks used instead
- `FatalError` is detected via `{ fatal: true }` or `{ name: "FatalError" }` and converted to `TerminalError`

## Service Name Extraction

The bundled code contains `__private_workflows.set("workflow//src/path/file.ts//FunctionName", fn)`. A regex extracts the full workflow ID, then `parseWorkflowName()` derives the short name (e.g., `FunctionName`) which becomes the Restate service name.
