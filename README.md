# ⬡ Harness CLI

**Multi-agent AI orchestrator** for coordinating Claude Code, Cursor, Codex, and other CLI coding agents.

Inspired by the hierarchical planner/worker architecture from [Cursor's self-driving codebases](https://cursor.com/blog/self-driving-codebases).

## Architecture

```
┌──────────────────────────────────────┐
│           Harness CLI                │
│                                      │
│  ┌─────────┐    ┌────────────────┐   │
│  │ Planner │───▶│  .harness/     │   │
│  └────┬────┘    │  ├─ agents/    │   │
│       │         │  ├─ tasks/     │   │
│  ┌────┴────┐    │  ├─ messages/  │   │
│  │         │    │  │   ├─ inbox/ │   │
│  ▼         ▼    │  │   └─ broadcast/ │
│ Worker   Worker │  ├─ plans/     │   │
│ Claude   Codex  │  └─ session.json   │
│                 └────────────────┘   │
└──────────────────────────────────────┘
```

**Key design principles:**
- **Hierarchical coordination** — A single planner owns task decomposition and assignment. Workers don't coordinate with each other.
- **File-based messaging** — Agents communicate via a shared `.harness/` directory. Simple, debuggable, no server needed.
- **Auto-discovery** — Harness detects running Claude Code, Cursor, and Codex sessions automatically.
- **Provider-agnostic** — Workers abstract over different CLI agents with a common interface.

## Quick Start

```bash
# Install dependencies
cd harness && bun install

# Initialize in your project
bun run src/cli.ts init

# Discover available agents
bun run src/cli.ts discover

# Run the demo
bun run src/cli.ts demo

# Quick single-task run
bun run src/cli.ts run "add error handling to src/api.ts"

# Execute a multi-task plan
bun run src/cli.ts plan "Refactor Auth" --file examples/plan-refactor-auth.json
```

## Commands

| Command | Description |
|---------|-------------|
| `init` | Initialize `.harness/` directory |
| `discover` | Scan for running AI agent sessions |
| `status` | Show session, agents, and plan status |
| `agents` | List all registered agents |
| `spawn <provider>` | Spawn a worker agent |
| `plan <title> --file <json>` | Execute a multi-task plan |
| `run <prompt>` | Quick single-task execution |
| `send <agentId> <msg>` | Send a message to an agent |
| `demo` | Run built-in demo scenario |
| `clean` | Remove stale agents and messages |

## Plan Files

Plans are JSON files that define tasks with dependencies:

```json
{
  "description": "What this plan does",
  "workers": ["claude-code", "codex"],
  "tasks": [
    {
      "title": "First task",
      "description": "Detailed instructions",
      "priority": "high",
      "files": ["src/main.ts"]
    },
    {
      "title": "Second task (depends on first)",
      "description": "Runs after first task completes",
      "dependsOnIndex": [0],
      "files": ["tests/main.test.ts"]
    }
  ]
}
```

## Supported Providers

| Provider | CLI Command | Status |
|----------|-------------|--------|
| Claude Code | `claude` | ✅ Full support |
| Cursor | `cursor` | 🔧 Background agent (stub) |
| OpenAI Codex | `codex` | ✅ Full support |
| Gemini CLI | `gemini` | 🔧 Planned |

## Development

```bash
# Run in dev mode
bun run dev

# Build for distribution
bun run build

# Link globally
bun link
```

## License

MIT
