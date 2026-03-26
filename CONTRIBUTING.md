# Contributing to Harness CLI

Thanks for your interest in contributing!

## Adding a new provider

The fastest way to contribute is adding a new AI CLI adapter. All providers live in `src/agents/` and follow the same interface:

1. Create `src/agents/<your-provider>.ts` extending `BaseAgentAdapter`
2. Implement `isAvailable()`, `execute()`, and optionally override `buildPrompt()`
3. Register it in `src/agents/index.ts` with one line:
   ```ts
   .register("your-provider", (opts) => new YourAdapter(opts))
   ```
4. Add the provider name to the `AgentProvider` union in `src/core/types.ts`

That's the entire surface area. `Worker`, `Planner`, and `Orchestrator` all pick it up automatically.

## Project structure

```
src/
├── agents/        # One file per AI CLI provider
├── commands/      # CLI sub-commands (watch, etc.)
├── core/          # Types, config, orchestrator
├── discovery/     # Process detection for each provider
├── planner/       # Planner + Worker lifecycle
├── transport/     # File-based message bus (.harness/)
└── utils/         # Logger, ID generation
```

## Development

```bash
bun install
bun run dev --help       # run CLI in dev mode
bun run build:check      # TypeScript type-check (no emit)
bun run build            # compile to dist/
```

## Guidelines

- Keep `Worker` provider-agnostic — all provider logic belongs in an adapter
- The planner should own coordination; workers should not coordinate with each other
- All new CLI commands should be `async` and handled in the IIFE at the bottom of `cli.ts`
- All provider-specific logic belongs in the adapter, not in the worker or planner

## Reporting issues

Please include:
- Your OS and Bun version (`bun --version`)
- Which AI CLI tool you're using and its version
- The command you ran and the full error output
- Contents of `.harness/session.json` if relevant (redact any tokens)
