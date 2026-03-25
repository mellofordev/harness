# ⬡ Harness CLI

**Multi-agent AI orchestrator** for coordinating Claude Code, Cursor, Codex, and other CLI coding agents.

Inspired by the hierarchical planner/worker architecture from [Cursor's self-driving codebases](https://cursor.com/blog/self-driving-codebases).

## Install

One command:

```bash
curl -fsSL https://raw.githubusercontent.com/mellofordev/harness/master/install.sh | bash
```

This installs Bun (if needed), clones the repo, compiles a standalone binary, and drops `harness` into your PATH. Run `harness-uninstall` to remove it.

### Other install methods

**Clone and run the setup script:**

```bash
git clone https://github.com/mellofordev/harness && cd harness
./setup.sh
```

**Manual (if you already have Bun):**

```bash
git clone https://github.com/mellofordev/harness && cd harness
bun install && bun link
```

**Compile a standalone binary (no Bun needed at runtime):**

```bash
bun run build:binary          # outputs dist/harness
sudo cp dist/harness /usr/local/bin/harness
```

---

## Quick start

```bash
cd your-project/
harness init              # creates .harness/ and config
harness discover          # check which AI CLIs are available
harness demo --dry-run    # safe walkthrough with no real API calls
```

### Run a single task

```bash
harness run "add error handling to src/api.ts"
harness run "write tests for auth.ts" --with codex
harness run "refactor the config module" --dry-run   # simulate only
```

### Run a multi-agent plan

```bash
# Terminal 1 — start the planner
harness plan "Refactor Auth" --file examples/plan-refactor-auth.json

# Terminal 2 — spawn a worker
harness spawn claude-code

# Terminal 3 — watch live activity
harness watch
```

---

## Commands

| Command | Description |
|---------|-------------|
| `init` | Initialize `.harness/` and write config |
| `discover` | Scan for running AI CLI sessions |
| `status` | Show agents, tasks, and plan status |
| `agents` | List all registered agents |
| `spawn <provider>` | Start a worker in this terminal |
| `plan <title> --file <json>` | Execute a multi-task plan |
| `run <prompt>` | Quick single-task execution |
| `send <agentId> <msg>` | Send a message to an agent |
| `watch` | Stream live `.harness/` activity |
| `logs` | Show recent message history |
| `demo` | Run the built-in demo (safe, dry-run) |
| `clean` | Remove stale agents and messages |

All commands accept `--dry-run` to simulate without calling any AI CLI.

---

## Plan files

Plans are JSON files that describe tasks with dependencies:

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
      "title": "Second task — runs after first completes",
      "description": "...",
      "dependsOnIndex": [0],
      "files": ["tests/main.test.ts"]
    }
  ]
}
```

See [`examples/`](./examples) for ready-to-use plans.

---

## Supported providers

| Provider | CLI | Status |
|----------|-----|--------|
| Claude Code | `claude` | ✅ Full support |
| Cursor | — | ✅ Workspace-inject strategy |
| OpenAI Codex | `codex` | ✅ Full support |
| Gemini CLI | `gemini` | 🔧 Planned |

---

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
│  │         │    │  ├─ plans/     │   │
│  ▼         ▼    │  └─ session.json   │
│ Worker   Worker └────────────────┘   │
│ Claude   Codex                       │
└──────────────────────────────────────┘
```

**Key principles:**
- **Hierarchical coordination** — a single planner owns task decomposition and assignment; workers don't coordinate with each other
- **File-based messaging** — all inter-agent communication goes through `.harness/`; simple, debuggable, no server needed
- **Provider-agnostic workers** — provider logic lives in `src/agents/<provider>.ts`; adding a new one requires no changes to the planner or worker

---

## Development

```bash
bun install
bun run dev              # run CLI directly (no install needed)
bun run build:check      # TypeScript type-check
bun run build            # compile to dist/ (Bun-targeted JS)
bun run build:binary     # compile to dist/harness standalone binary
bun link                 # register `harness` globally for local dev
```

---

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md).

## License

MIT
