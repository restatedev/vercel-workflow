# My New Monorepo

A TypeScript monorepo with comprehensive tooling for building, testing, and publishing libraries.

## Features

- 📦 PNPM Workspaces with catalogs
- 🏗️ TypeScript Project References
- ⚡ Fast builds with tsdown
- 🧪 Vitest for testing
- 🎨 ESLint & Prettier
- 📝 Changesets for versioning
- 🤖 GitHub Actions CI/CD
- 🚀 Turbo for smart caching

## Quick Start

```bash
# Install dependencies
pnpm install

# Create your first package
pnpm new

# Start dev mode (type checking only, no builds!)
pnpm dev

# Run tests in watch mode
pnpm test:watch

# Build lib packages (when ready to test production builds)
pnpm build

# Run all checks (before committing)
pnpm verify
```

## Package Management

### Create a Package

```bash
pnpm new
```

This will prompt you for:
- **Package type**: `lib` (library), `test` (test package), or `example` (example app)
- **Package name**: e.g., `my-package`
- **Private**: Whether the package should be private (for libs only)

The generator will:
- Create the package structure
- Generate TypeScript configs
- Update workspace path mappings
- Install dependencies automatically

### Delete a Package

```bash
pnpm delete
```

Select a package to remove. Dependencies and TypeScript path mappings will be automatically cleaned up.

### Add Custom Entry Points

```bash
pnpm add-entry
```

Add subpath exports to a public lib (e.g., `@restatedev/my-lib/utils`). This automatically:
- Creates the source file
- Updates package.json exports and typesVersions
- Configures tsdown, API Extractor, and TypeScript paths
- Ensures all validation tools work with the new entry

## Documentation

- **[DEVELOPMENT.md](./DEVELOPMENT.md)** - Complete development guide covering:
  - Package types and structure
  - Managing dependencies
  - Development workflow
  - Testing and building
  - Publishing and releases
  - GitHub Actions setup

- **[AGENTS.md](./AGENTS.md)** - Guide for AI coding assistants working with this monorepo:
  - Project overview and key concepts
  - Common tasks and patterns
  - Configuration details
  - Best practices and troubleshooting
