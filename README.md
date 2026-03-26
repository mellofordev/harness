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
harness                   # open the interactive console
harness discover          # check which AI CLIs are available
harness demo --dry-run    # safe walkthrough with no real API calls
```

### Run a single task

```bash
harness run "add error handling to src/api.ts"
harness run "write tests for auth.ts" --with codex
harness plan "refactor the config module"
harness run "refactor the config module" --dry-run   # simulate only
```

`harness run` is the execution path: give Harness a prompt, feature request, issue description, or file reference and it will auto-detect local AI CLIs, choose a lead agent, decompose the work, and execute.

`harness plan` is the review-first variant: it takes the same kind of prompt, shows the generated task split, then runs it.

You can also open the interactive console explicitly with `harness ui`.

Inside the interactive console, the prompt box also accepts slash commands:
- `/exit` — leave the interactive Harness console
- `/help` — show available slash commands
- `/plan` — switch the console to plan mode
- `/normal` — switch the console to normal mode
- `/clear` — clear the local UI state
- `/discover` — refresh detected local CLIs
- `/watch` — print the current plan/task snapshot into the transcript
- `/agents` — list registered agents and their current status
- `/version` — print the installed Harness version

When the slash-command menu is open, use the up/down arrow keys to move through the available commands and press Enter to run the selected one.

### Run a multi-agent plan

```bash
# Preview the decomposition before execution
harness plan "@README.md implement the missing UX described here"

# Watch live activity in another terminal
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
| `run <prompt>` | Execute a prompt through auto-orchestrated agents |
| `plan <prompt>` | Preview the generated decomposition, then execute |
| `ui` | Open the interactive Harness console |
| `version` | Print the installed Harness CLI version |
| `send <agentId> <msg>` | Send a message to an agent |
| `watch` | Stream live `.harness/` activity |
| `logs` | Show recent message history |
| `demo` | Run the built-in demo (safe, dry-run) |
| `clean` | Remove stale agents and messages |
| `spawn <provider>` | Advanced: manually start a worker |

All commands accept `--dry-run` to simulate without calling any AI CLI.

---

## Prompt-First Workflow

Harness should feel like using Codex or Claude Code, not like writing a workflow spec.

You can give it:
- a short prompt
- a full feature description
- a pasted issue
- a file reference such as `@README.md`

Harness then:
- detects which coding CLIs are available on the machine
- selects a lead agent to decompose the work
- spawns workers automatically
- schedules the resulting tasks through the internal planner

The planner still exists internally, but users should not have to author plans by hand.

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
- **Prompt-first execution** — Harness can take a user prompt, auto-detect local AI CLIs, choose a lead decomposer, and split work across the rest

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

## Updating

Installed via the one-line installer:

```bash
curl -fsSL https://raw.githubusercontent.com/mellofordev/harness/main/install.sh | bash
```

Installed from a local clone:

```bash
./update.sh
```

Verify the installed CLI version with `harness version`.

---

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md).

## License

MIT
