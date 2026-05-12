# Workflow examples

Each example is a Next.js API route under `src/app/api/<name>/route.ts` that drives a workflow in `src/workflows/<name>.ts`.

## One-time setup

```sh
# 1. Start Restate (in another terminal)
npx @restatedev/restate-server

# 2. Start the example app
pnpm --filter @restatedev/workflow-example dev

# 3. Register the deployment with Restate
npx @restatedev/restate deployments register \
  http://localhost:3000/.restate-well-known --use-http1.1
```

Default endpoints used below: app `http://localhost:3000`, Restate ingress `http://localhost:8080`.

To smoke-test most examples in one shot, run `./scripts/run-all.sh` after the app is up.

---

## Plain workflows (`a`–`e`)

Start, await result, return JSON. No params needed unless noted.

### a-simple — two-step calculation
```sh
curl -X POST http://localhost:3000/api/a-simple
```

### b-sleep — workflow with `ctx.sleep`
```sh
curl -X POST http://localhost:3000/api/b-sleep
```

### c-fatal-error — non-retried failure (`FatalError`)
```sh
curl -X POST http://localhost:3000/api/c-fatal-error
```
Calls a step that throws `FatalError`; the run completes as `failed` without retrying. Response shows the parsed cause.

### d-retryable-error — retried failure
```sh
curl -X POST http://localhost:3000/api/d-retryable-error
```
Steps retry per Restate's retry policy until terminal failure.

### e-sagas — compensating actions on failure
```sh
curl -X POST http://localhost:3000/api/e-sagas
```

---

## Hooks (`f`, `g`, `h`, `i`, `l`, `o`)

Workflows that pause on `await hook` until something resumes them via `resumeHook(token, payload)`.

### f-hooks — random-token hook + manual resume
```sh
# Start (returns runId; the token is printed in dev-server logs)
curl -X POST http://localhost:3000/api/f-hooks

# Resume — paste the token from the logs
curl -X POST http://localhost:3000/api/f-resume \
  -H 'Content-Type: application/json' \
  -d '{"token":"hook-...","approved":true,"comment":"lgtm"}'
```

### g-custom-hooks — fixed-token hook (`slack_messages:channel123`)
```sh
curl -X POST http://localhost:3000/api/g-custom-hooks
curl -X POST http://localhost:3000/api/g-resume   # resumes with a known token
```

### h-hooks-multiple-events — same hook resolved repeatedly
```sh
# Start (token printed in dev-server logs)
curl -X POST http://localhost:3000/api/h-hooks-multiple-events

# Send several values, then a {done:true} to stop the loop
curl -X POST http://localhost:3000/api/h-resume \
  -H 'Content-Type: application/json' -d '{"token":"hook-...","value":1}'
curl -X POST http://localhost:3000/api/h-resume \
  -H 'Content-Type: application/json' -d '{"token":"hook-...","value":2}'
curl -X POST http://localhost:3000/api/h-resume \
  -H 'Content-Type: application/json' -d '{"token":"hook-...","value":3,"done":true}'
```

### i-disposing-hooks-early — hook released by `using` scope on `handoff:true`
```sh
# Start (default channelId is "channel123")
curl -X POST http://localhost:3000/api/i-disposing-hooks-early

# Send messages; {handoff:true} ends the inner block and disposes the hook
curl -X POST http://localhost:3000/api/i-resume \
  -H 'Content-Type: application/json' -d '{"message":"hello"}'
curl -X POST http://localhost:3000/api/i-resume \
  -H 'Content-Type: application/json' -d '{"message":"bye","handoff":true}'
```

### l-manual-hook-disposal — explicit `hook.dispose()`
```sh
curl -X POST http://localhost:3000/api/l-manual-hook-disposal
curl -X POST http://localhost:3000/api/l-resume
```

### o-typed-hooks — Zod-validated hook payload
```sh
# Start
curl -X POST http://localhost:3000/api/o-typed-hooks \
  -H 'Content-Type: application/json' \
  -d '{"documentId":"doc-test"}'

# Resume (payload is validated against the schema)
curl -X POST http://localhost:3000/api/o-resume \
  -H 'Content-Type: application/json' \
  -d '{"documentId":"doc-test","requestId":"req-1","approved":true,"approvedBy":"alice","comment":"ok"}'
```

---

## Webhooks (`j`, `k`, `m`, `n`)

`createWebhook()` allocates a public URL the workflow waits on. The URL is printed to the dev-server logs.

### j-webhooks — single inbound request
```sh
curl -X POST http://localhost:3000/api/j-webhooks
# Then POST to the webhook URL printed in the dev-server logs:
curl -X POST '<webhook-url-from-logs>' \
  -H 'Content-Type: application/json' -d '{"hello":"world"}'
```

### k-webhooks-auto-response — webhook returns a static `Response`
```sh
curl -X POST http://localhost:3000/api/k-webhooks-auto-response
# POST to the printed webhook URL — it auto-responds with {success:true}.
```

### m-webhook-dynamic-response — response chosen per request body
```sh
curl -X POST http://localhost:3000/api/m-webhook-dynamic-response
# POST {"type":"urgent"} or {"type":"normal"} to the printed URL.
```

### n-webhook-multiple-requests — workflow consumes a stream of webhook calls
```sh
curl -X POST http://localhost:3000/api/n-webhook-multiple-requests
# POST events to the printed URL; send {"type":"done"} to finish.
```

---

## Idempotency (`y`)

```sh
curl -X POST http://localhost:3000/api/y-idempotency \
  -H 'Content-Type: application/json' \
  -d '{"userId":"user_test","amount":2500}'
```
Calling twice with the same `userId` returns the same `chargeId` (the workflow uses an idempotency key derived from inputs).

---

## Streaming (`p`–`x`) — currently broken

The streaming runtime is being rewritten; these examples will not work until that lands.

| Example | Workflow | Route |
|---|---|---|
| p-streaming-basic | `simpleStreamingWorkflow` | `POST /api/p-streaming-basic` (returns the stream) |
| q-streaming-resume | `resumableStreamWorkflow` | `POST /api/q-streaming-resume`, then `GET /api/q-streaming-resume/<runId>?startIndex=N` |
| r-streaming-input-arg | `streamProcessingWorkflow` | `POST /api/r-streaming-input-arg` with a request body |
| s-streaming-namespaced | `multiStreamWorkflow` | `POST /api/s-streaming-namespaced` (reads the `logs` namespace) |
| t-streaming-progress | `batchProcessingWorkflow` | `POST /api/t-streaming-progress` `{"items":[...]}` |
| u-streaming-between-steps | `streamPipelineWorkflow` | `POST /api/u-streaming-between-steps` |
| v-streaming-file-pipeline | `fileProcessingWorkflow` | `POST /api/v-streaming-file-pipeline` `{"fileUrl":"..."}` |
| w-streaming-errors | `streamErrorWorkflow` | `POST /api/w-streaming-errors` |
| x-streaming-ai | `aiAssistantWorkflow` | `POST /api/x-streaming-ai` `{"message":"..."}` (needs `ANTHROPIC_API_KEY`) |

---

## Inspecting runs

```sh
pnpm --filter @restatedev/workflow-example inspect   # workflow inspect runs
```
