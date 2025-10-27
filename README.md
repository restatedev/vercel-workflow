# Vercel Restate World

A TypeScript monorepo demonstrating Restate integration with Vercel Workflow. See [DEVELOPMENT.md](./DEVELOPMENT.md) for comprehensive monorepo documentation.

# Warning

This integration is currently under construction.

## Packages

- **`@restatedev/world`**: Package using typed client to implement World by talking to Restate virtual objects/services
- **`@restatedev/backend`**: Collection of Restate virtual objects and services  
- **`@restatedev/common`**: Common types package (private, not publishable)
- **`@restatedev/workflow`**: Example package built using `workflow` package

## Quick Start

```bash
# Install dependencies
pnpm install

# Start dev mode (type checking)
pnpm dev

# Run workflow example
pnpm examples:dev

# Build and run backend service
pnpm build
pnpm backend:run

# Inspect workflows
pnpm inspect

# Run all checks (before committing)
pnpm verify
```

## Documentation

- **[DEVELOPMENT.md](./DEVELOPMENT.md)** - Complete monorepo guide (PNPM, Turbo, tsdown, Vitest, Changesets)
- **[AGENTS.md](./AGENTS.md)** - Guide for AI coding assistants with commands, code style, and best practices
