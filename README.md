# Restate + useworkflow.dev

Use Restate with [useworkflow.dev](http://useworkflow.dev).

> [!IMPORTANT]
> This integration is a proof of concept.

## How to use it

To run this integration, you'll need:

* The `@restatedev/world` package
* Restate + Restate `World` backend
* An example workflow from Vercel `workflow-examples` repo.

### Prepare the `@restatedev/world` package

1. Clone this repo
```shell
git clone https://github.com/restatedev/vercel-workflow.git
cd vercel-workflow
```

2. Build it
```shell
pnpm install
pnpm build
pnpm package
```

### Run Restate and the Restate `world` backend

Run in the root of this repo:

```shell
docker compose up
```

To start Restate, together with the service implementing the `World` backend.

### Run a Workflow example

Grab any of the Vercel workflow examples, e.g., the Flight booking example, cloning it in a new directory:

```shell
git clone https://github.com/vercel/workflow-examples
cd workflow-examples/flight-booking-app
```

Each example might require additional setup, e.g. the flight booking app requires a Vercel API Gateway key in the `.env.local` file:

```shell
touch .env.local
echo "API_GATEWAY_KEY=<YOUR_KEY>" >> .env.local
```

Then install `@restatedev/world`:

```shell
pnpm add <DIR_WHERE_YOU_CLONED_THIS_REPO>/restatedev-vercel-world-0.0.0.tgz
```

Now setup Vercel to use `@restatedev/world`:

```shell
export WORKFLOW_TARGET_WORLD=@restatedev/vercel-world
```

And you're ready to run the example:

```shell
pnpm dev
```

Head over to http://localhost:3000 and you're ready to use the example.
You can access the Restate UI at http://localhost:9070.

You can also use the Vercel inspection UI with:

```shell
npx workflow inspect run --web
```

Enjoy!