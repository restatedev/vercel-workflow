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


## What this adds on top of Vercel Workflow


You can supply to start():
- Delayed execution
- Idempotency 

What doesnt work yet:
- step.maxAttempts https://workflow-sdk.dev/docs/foundations/errors-and-retries#default-retrying
- retryableError?
- waiting on a hook leads to super many reinvocations? maybe restate is waking us up constantly? ask Francesco
- I dont think we need a sleepObjects because wakeUp is only for tests... Ask Igal how to solve this
- Implementing: `world.runs.list` / `world.events.list` / `world.steps.list` / `world.hooks.list`
- Implementing streaming with pubsub
- Cancelation of a step is implemented a bit hacky, with a sleep loop in case attach finishes before the workflow status is updated. It may be better to move back to having the workflow object actually wait for the completion. 