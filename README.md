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

This creates the `@restatedev/world` package that bridges Vercel Workflow to Restate.

### 2. Start the Restate infrastructure

```shell
docker compose up
```

This spins up both Restate and the World backend service. Leave this running.

### 3. Run a Vercel Workflow example

In a new terminal, grab any example from Vercel's collection:

```shell
git clone https://github.com/vercel/workflow-examples
cd workflow-examples/flight-booking-app
```

Install the `@restatedev/world` package:

```shell
pnpm add <PATH_TO_CLONED_REPO>/restatedev-vercel-world-0.0.0.tgz
```

Configure Vercel Workflow to use Restate:

```shell
export WORKFLOW_TARGET_WORLD=@restatedev/vercel-world
```

Some examples need additional config (like API keys). Check the example's README and add them to `.env.local`:

```shell
echo "API_GATEWAY_KEY=<YOUR_KEY>" >> .env.local
```

Start the dev server:

```shell
pnpm dev
```

### 4. See it in action

- **Your app:** http://localhost:3000
- **Restate UI:** http://localhost:9070/ui/state/workflow — Check the workflow state in Restate's virtual objects
- **Workflow Inspector:** Run `npx workflow inspect run --web` for Vercel's debugging tools

Now trigger a workflow in your app and watch it execute through Restate's infrastructure. Every step is persisted, observable, and resumable.

Check out [restate.dev](https://restate.dev) for more on durable execution.