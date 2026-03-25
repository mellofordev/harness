#!/usr/bin/env bun
/**
 * Harness CLI — Entry Point
 *
 * Usage:
 *   harness init                          Initialize .harness/ in current directory
 *   harness discover                      Scan for running AI CLI agents
 *   harness status                        Show current session status
 *   harness spawn <provider>              Spawn a worker agent (long-running)
 *   harness plan <prompt>                 Preview the generated orchestration plan
 *   harness run <prompt>                  Execute a prompt immediately via orchestration
 *   harness agents                        List registered agents
 *   harness send <agentId> <message>      Send a message to an agent
 *   harness watch                         Stream real-time .harness/ activity
 *   harness logs [--tail N]               Show recent message history
 *   harness demo                          Run the built-in demo scenario
 *   harness clean                         Clean stale agents and old messages
 */

import { resolve, join } from "node:path";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { Orchestrator } from "./core/orchestrator";
import { DEFAULT_CONFIG, type AgentProvider, type HarnessConfig } from "./core/types";
import { loadConfig, writeDefaultConfig, getAdapterConfig } from "./core/config";
import { autoSpawn } from "./core/auto-spawn";
import { REGISTRY } from "./agents/index";
import { startWatch } from "./commands/watch";
import { logger } from "./utils/logger";
import type { TaskDefinition } from "./planner/planner";
import { decomposePrompt } from "./planner/ai-decomposer";
import type { Message } from "./core/types";

// ─── Argument Parsing ──────────────────────────────────────────

const args = process.argv.slice(2);
const command = args[0];
const subArgs = args.slice(1);

function getFlag(flag: string): string | undefined {
  const idx = args.indexOf(flag);
  return idx !== -1 ? args[idx + 1] : undefined;
}

function hasFlag(flag: string): boolean {
  return args.includes(flag);
}

function getPositionals(excludedFlags: string[] = []): string[] {
  const flagsWithValues = new Set(excludedFlags);
  const positionals: string[] = [];

  for (let i = 0; i < subArgs.length; i++) {
    const arg = subArgs[i];
    if (arg.startsWith("--")) {
      if (flagsWithValues.has(arg)) i++;
      continue;
    }
    positionals.push(arg);
  }

  return positionals;
}

const isDryRun = hasFlag("--dry-run");
const isVerbose = hasFlag("--verbose") || hasFlag("-v");

if (isVerbose) logger.setLevel("debug");

// ─── Config ────────────────────────────────────────────────────

function resolveConfig(overrides?: Partial<HarnessConfig>): HarnessConfig {
  const workDir = getFlag("--dir") || process.cwd();
  return loadConfig(workDir, overrides);
}

function resolveHarnessDir(config: HarnessConfig): string {
  return join(resolve(config.workDir), config.harnessDir);
}

// ─── Commands ──────────────────────────────────────────────────

async function cmdInit() {
  const workDir = getFlag("--dir") || process.cwd();
  const harnessDir = join(resolve(workDir), DEFAULT_CONFIG.harnessDir);

  if (existsSync(harnessDir)) {
    logger.info(".harness/ already exists — re-initializing config");
  }

  writeDefaultConfig(workDir);

  const config = loadConfig(workDir);
  const orchestrator = new Orchestrator(config);
  await orchestrator.init(true);

  console.log(`\n${C.green}✓ Harness initialized${C.reset}\n`);
  console.log(`  Workspace:  ${resolve(workDir)}`);
  console.log(`  State dir:  ${harnessDir}`);
  console.log(`  Config:     ${join(harnessDir, "config.json")}\n`);

  // Check what's available
  console.log("Checking available AI CLI tools...\n");
  const availability = await REGISTRY.checkAll();
  for (const [provider, available] of Object.entries(availability)) {
    const icon = available ? `${C.green}✓` : `${C.red}✗`;
    console.log(`  ${icon}${C.reset}  ${provider}`);
  }

  const anyAvailable = Object.values(availability).some(Boolean);
  if (!anyAvailable) {
    console.log(
      `\n${C.yellow}⚠ No AI CLI tools found on PATH.${C.reset}\n` +
        "  Install at least one:\n" +
        "    Claude Code: https://claude.ai/code\n" +
        "    Codex:       npm install -g @openai/codex\n"
    );
  }

  console.log(`\n  Next: ${C.cyan}harness discover${C.reset}  or  ${C.cyan}harness demo --dry-run${C.reset}\n`);
  await orchestrator.shutdown();
}

async function cmdDiscover() {
  const config = resolveConfig();
  const orchestrator = new Orchestrator(config);
  await orchestrator.init(true);

  const { running, available } = orchestrator.discover();

  console.log(`\n${C.bold}📡 Discovery Results${C.reset}\n`);

  console.log("  Running sessions:");
  if (running.length > 0) {
    for (const r of running) {
      const pidStr = r.pid ? ` (PID: ${r.pid})` : "";
      const dirStr = r.sessionDir ? `\n    ${C.gray}session: ${r.sessionDir}${C.reset}` : "";
      console.log(`    ${providerColor(r.provider)}⬡ ${r.provider}${C.reset}${pidStr}${dirStr}`);
    }
  } else {
    console.log(`    ${C.gray}none detected${C.reset}`);
  }

  console.log("\n  Available CLI tools:");
  for (const [provider, isAvailable] of Object.entries(available)) {
    const icon = isAvailable ? `${C.green}✓` : `${C.red}✗`;
    console.log(`    ${icon}${C.reset}  ${provider}`);
  }
  console.log();

  await orchestrator.shutdown();
}

async function cmdStatus() {
  const config = resolveConfig();
  const harnessDir = resolveHarnessDir(config);

  if (!existsSync(harnessDir)) {
    console.log(`\n${C.yellow}No .harness/ directory found.${C.reset} Run 'harness init' first.\n`);
    return;
  }

  // Read state directly from disk (no need to spin up orchestrator)
  const sessionFile = join(harnessDir, "session.json");
  const session = existsSync(sessionFile)
    ? JSON.parse(readFileSync(sessionFile, "utf-8"))
    : null;

  const agents = readJsonDir(join(harnessDir, "agents"));
  const tasks = readJsonDir(join(harnessDir, "tasks"));
  const plans = readJsonDir(join(harnessDir, "plans"));

  console.log(`\n${C.bold}📊 Harness Status${C.reset}\n`);

  if (session) {
    console.log(`  Session:  ${session.id}`);
    console.log(`  WorkDir:  ${session.workDir}`);
    console.log(`  Status:   ${colorStatus(session.status)}`);
    console.log(`  Started:  ${new Date(session.startedAt).toLocaleString()}`);
  } else {
    console.log(`  ${C.yellow}No active session${C.reset}`);
  }

  if (agents.length > 0) {
    console.log(`\n  ${C.bold}Agents (${agents.length}):${C.reset}`);
    for (const agent of agents as any[]) {
      const age = Math.round((Date.now() - agent.lastHeartbeat) / 1000);
      const stale = age > 30 ? ` ${C.red}(stale)${C.reset}` : "";
      console.log(
        `    ${providerColor(agent.provider)}⬡ ${agent.provider}${C.reset}` +
          ` ${C.dim}[${agent.id.slice(0, 10)}]${C.reset}` +
          ` ${agent.role}  ${colorStatus(agent.status)}  ${C.gray}${age}s ago${stale}${C.reset}`
      );
    }
  } else {
    console.log(`\n  ${C.gray}No agents registered${C.reset}`);
  }

  if (plans.length > 0) {
    for (const plan of plans as any[]) {
      if (plan.status !== "active") continue;
      const done = tasks.filter((t: any) => t.status === "completed").length;
      const failed = tasks.filter((t: any) => t.status === "failed").length;
      console.log(
        `\n  ${C.bold}Plan: ${plan.title}${C.reset}  ${colorStatus(plan.status)}`
      );
      console.log(
        `    Tasks: ${tasks.length} total  ` +
          `${C.green}${done} done${C.reset}  ` +
          `${C.yellow}${tasks.filter((t: any) => t.status === "in_progress").length} active${C.reset}  ` +
          `${failed > 0 ? `${C.red}${failed} failed${C.reset}  ` : ""}` +
          `${tasks.filter((t: any) => t.status === "pending").length} pending`
      );

      if (tasks.length > 0) {
        console.log(`\n  ${C.bold}Tasks:${C.reset}`);
        for (const task of tasks as any[]) {
          const assignee = task.assignedTo
            ? `${C.gray} → ${task.assignedTo.slice(0, 8)}${C.reset}`
            : "";
          console.log(
            `    ${colorStatus(task.status)} ${C.dim}[${task.id.slice(0, 8)}]${C.reset}` +
              ` "${task.title.slice(0, 55)}"${assignee}`
          );
        }
      }
    }
  }

  console.log();
}

async function cmdSpawn() {
  const provider = subArgs[0] as AgentProvider;
  const PROVIDERS: AgentProvider[] = ["claude-code", "cursor", "codex", "gemini-cli"];

  if (!provider || !PROVIDERS.includes(provider)) {
    console.error(
      `Usage: harness spawn <provider>\nProviders: ${PROVIDERS.join(" | ")}`
    );
    process.exit(1);
  }

  const config = resolveConfig();
  const adapterConfig = getAdapterConfig(config.workDir);

  // Apply dry-run to adapter options
  const adapterOptions: Record<string, unknown> = {
    ...(adapterConfig[provider as keyof typeof adapterConfig] || {}),
    dryRun: isDryRun,
  };

  const orchestrator = new Orchestrator(config);
  await orchestrator.init(true);

  // Check if CLI is available (skip check in dry-run)
  if (!isDryRun) {
    const available = await REGISTRY.create(provider)?.isAvailable();
    if (!available) {
      console.warn(
        `\n${C.yellow}⚠ Warning: '${provider}' CLI not found on PATH.${C.reset}\n` +
          `  Worker will start but tasks will fail without the CLI.\n` +
          `  Use --dry-run to simulate execution.\n`
      );
    }
  }

  const worker = orchestrator.spawnWorker(provider, config.workDir, adapterOptions);

  console.log(
    `\n${C.green}✓ Worker spawned${C.reset}` +
      `${isDryRun ? ` ${C.yellow}[DRY RUN]${C.reset}` : ""}` +
      `\n  ID:       ${worker.getId()}` +
      `\n  Provider: ${provider}` +
      `\n  WorkDir:  ${config.workDir}` +
      `\n\n  Polling for tasks every ${config.pollIntervalMs}ms. Press Ctrl+C to stop.\n`
  );

  process.on("SIGINT", async () => {
    console.log("\nStopping worker...");
    await orchestrator.shutdown();
    process.exit(0);
  });

  await new Promise<never>(() => {}); // Keep process alive
}

async function cmdAgents() {
  const config = resolveConfig();
  const harnessDir = resolveHarnessDir(config);
  const agentsDir = join(harnessDir, "agents");

  if (!existsSync(agentsDir)) {
    console.log("\nNo agents registered. Use 'harness spawn <provider>' to create one.\n");
    return;
  }

  const agents = readJsonDir(agentsDir) as any[];

  if (agents.length === 0) {
    console.log("\nNo agents registered.\n");
    return;
  }

  console.log(`\n${C.bold}🤖 Registered Agents (${agents.length})${C.reset}\n`);
  for (const agent of agents) {
    const age = Math.round((Date.now() - agent.lastHeartbeat) / 1000);
    const stale = age > 30;
    console.log(
      `  ${providerColor(agent.provider)}⬡ ${agent.provider}${C.reset}` +
        ` ${C.dim}[${agent.id}]${C.reset}`
    );
    console.log(
      `    Role: ${agent.role}  Status: ${colorStatus(agent.status)}  Last seen: ${age}s ago${stale ? ` ${C.red}(stale)${C.reset}` : ""}`
    );
    console.log(`    Capabilities: ${agent.capabilities.join(", ")}`);
    console.log();
  }
}

async function cmdSend() {
  const targetId = subArgs[0];
  const message = subArgs.slice(1).join(" ");

  if (!targetId || !message) {
    console.error("Usage: harness send <agentId> <message>");
    process.exit(1);
  }

  const config = resolveConfig();
  const orchestrator = new Orchestrator(config);
  await orchestrator.init(true);

  const msg = orchestrator.getBus().send({
    type: "query",
    from: "cli-user",
    to: targetId,
    payload: { question: message },
    ttl: 60_000,
  });

  console.log(`\n${C.green}✉ Message sent${C.reset}: ${msg.id} → ${targetId}\n`);
  await orchestrator.shutdown();
}

async function cmdPlan() {
  const prompt = getPositionals(["--with", "--timeout", "--dir"]).join(" ");
  if (!prompt) {
    console.error(
      "Usage: harness plan <prompt> [--with <provider>] [--dry-run]\n\n" +
        "Examples:\n" +
        '  harness plan "implement OAuth login flow"\n' +
        '  harness plan "fix auth race condition in src/auth.ts"\n' +
        '  harness plan "@README.md implement the UX described here"'
    );
    process.exit(1);
  }
  await runPromptFlow(prompt, "plan");
}

async function cmdRun() {
  const promptParts = getPositionals(["--with", "--timeout", "--dir"]);
  const prompt = promptParts.join(" ");

  if (!prompt) {
    console.error(
      "Usage: harness run <prompt> [--with <provider>] [--dry-run]\n\n" +
        "Examples:\n" +
        '  harness run "add error handling to src/api.ts"\n' +
        '  harness run "write tests for utils.ts" --with codex\n' +
        '  harness run "refactor auth module" --dry-run'
    );
    process.exit(1);
  }

  await runPromptFlow(prompt, "normal");
}

async function runPromptFlow(prompt: string, mode: "normal" | "plan") {
  const config = resolveConfig();
  const orchestrator = new Orchestrator(config);
  await orchestrator.init(true);
  const requestedProvider = getFlag("--with") as AgentProvider | undefined;
  let title = "Quick Run";
  let description = prompt;
  let tasks: TaskDefinition[] = [];
  let workerProviders: AgentProvider[] = [];
  let leadProvider: AgentProvider | null = null;

  try {
    if (requestedProvider) {
      const adapterConfig = getAdapterConfig(config.workDir);
      const adapterOptions: Record<string, unknown> = {
        ...(adapterConfig[requestedProvider as keyof typeof adapterConfig] || {}),
        dryRun: isDryRun,
      };

      if (!isDryRun) {
        const available = await REGISTRY.create(requestedProvider)?.isAvailable();
        if (!available) {
          console.warn(
            `\n${C.yellow}⚠ '${requestedProvider}' CLI not found. Use --dry-run to simulate.${C.reset}\n`
          );
        }
      }

      orchestrator.spawnWorker(requestedProvider, config.workDir, adapterOptions);
      workerProviders = [requestedProvider];
      leadProvider = requestedProvider;
    } else {
      const auto = await autoSpawn(orchestrator, config, { dryRun: isDryRun });
      workerProviders = auto.spawned;
      leadProvider = auto.lead;
    }

    if (!leadProvider) {
      throw new Error("No lead provider available for decomposition");
    }

    const decomposed = await decomposePrompt(prompt, {
      provider: leadProvider,
      workDir: config.workDir,
      mode,
      model: config.decomposerModel,
      dryRun: isDryRun,
    });

    title = decomposed.title;
    description = decomposed.description;
    tasks = decomposed.tasks;

    if (tasks.length === 0) {
      tasks = [
        {
          title: prompt.slice(0, 80),
          description: prompt,
          priority: "normal",
        },
      ];
    }

    console.log(
      `\n${C.cyan}${mode === "plan" ? "Planning" : "Running"} with Harness${C.reset}` +
        `${isDryRun ? ` ${C.yellow}[DRY RUN]${C.reset}` : ""}\n` +
        `  Prompt:   "${prompt.slice(0, 90)}"\n` +
        `  Lead:     ${leadProvider}\n` +
        `  Workers:  ${workerProviders.join(", ")}\n` +
        `  Tasks:    ${tasks.length}\n`
    );

    if (mode === "plan") {
      console.log(`${C.bold}Plan${C.reset}`);
      console.log(`  Title: ${title}`);
      console.log(`  Summary: ${description}`);
      for (const [index, task] of tasks.entries()) {
        const deps = task.dependsOnIndex?.map((n) => n + 1).join(", ");
        const files = task.files?.length ? task.files.join(", ") : "(project context)";
        console.log(
          `  ${index + 1}. ${task.title} ${C.dim}[${task.priority || "normal"}]${C.reset}`
        );
        console.log(`     Files: ${files}`);
        if (deps) console.log(`     Depends on: ${deps}`);
      }
      console.log();
    }

    await orchestrator.executePlan(title, description, tasks);
  } catch (err) {
    await orchestrator.shutdown();
    throw err;
  }

  const timeoutMs = parseInt(getFlag("--timeout") || "120000");
  const start = Date.now();

  await new Promise<void>((resolve) => {
    const dots = setInterval(() => process.stdout.write("."), 1000);
    const check = setInterval(() => {
      const planner = orchestrator.getPlanner();
      if (!planner) return;
      const status = planner.getStatus();
      if (status.status === "completed" || planner.isPlanFailed() || Date.now() - start > timeoutMs) {
        clearInterval(check);
        clearInterval(dots);
        process.stdout.write("\n");
        resolve();
      }
    }, 1000);
  });

  const finalStatus = orchestrator.getPlanner()?.getStatus();
  const tasks_ = readJsonDir(join(resolveHarnessDir(config), "tasks")) as any[];
  const completedTasks = tasks_.filter((task: any) => task?.result);

  if (completedTasks.length > 0) {
    console.log(`\n${C.bold}Results:${C.reset}`);
    for (const task of completedTasks) {
      console.log(
        `  ${colorStatus(task.result.success ? "completed" : "failed")} ${task.title}`
      );
      console.log(`    Summary: ${task.result.summary}`);
      if (task.result.filesChanged?.length > 0) {
        console.log(`    Files:   ${task.result.filesChanged.join(", ")}`);
      }
      if (task.result.output && completedTasks.length === 1) {
        console.log(`\n  Output:\n${C.gray}${task.result.output.slice(0, 1000)}${C.reset}`);
      }
    }
  }

  await orchestrator.shutdown();
  process.exit(finalStatus?.tasks.failed ? 1 : 0);
}

async function cmdWatch() {
  const config = resolveConfig();
  const harnessDir = resolveHarnessDir(config);
  const refreshMs = parseInt(getFlag("--interval") || "1000");

  const stop = startWatch(harnessDir, refreshMs);

  process.on("SIGINT", () => {
    stop();
    console.log("\n\nWatch stopped.\n");
    process.exit(0);
  });

  await new Promise<never>(() => {}); // Keep alive
}

async function cmdLogs() {
  const config = resolveConfig();
  const harnessDir = resolveHarnessDir(config);
  const tail = parseInt(getFlag("--tail") || "50");

  if (!existsSync(harnessDir)) {
    console.log("\nNo .harness/ directory found. Run 'harness init' first.\n");
    return;
  }

  const allMsgs: Message[] = [];

  // Gather from processed inboxes
  const inboxDir = join(harnessDir, "messages", "inbox");
  if (existsSync(inboxDir)) {
    for (const agentDir of readdirSync(inboxDir)) {
      const processedDir = join(inboxDir, agentDir, ".processed");
      if (existsSync(processedDir)) {
        for (const f of readdirSync(processedDir).filter((f) => f.endsWith(".json"))) {
          try {
            allMsgs.push(JSON.parse(readFileSync(join(processedDir, f), "utf-8")));
          } catch {
            // Skip
          }
        }
      }
    }
  }

  // Gather from broadcast
  const broadcastDir = join(harnessDir, "messages", "broadcast");
  if (existsSync(broadcastDir)) {
    for (const f of readdirSync(broadcastDir).filter((f) => f.endsWith(".json"))) {
      try {
        allMsgs.push(JSON.parse(readFileSync(join(broadcastDir, f), "utf-8")));
      } catch {
        // Skip
      }
    }
  }

  allMsgs.sort((a, b) => a.timestamp - b.timestamp);
  const recent = allMsgs.slice(-tail);

  console.log(`\n${C.bold}📋 Message Log (last ${recent.length})${C.reset}\n`);

  if (recent.length === 0) {
    console.log(`  ${C.gray}No messages yet${C.reset}\n`);
    return;
  }

  for (const msg of recent) {
    const time = new Date(msg.timestamp).toISOString().split("T")[1].slice(0, 12);
    const from = msg.from.slice(0, 12).padEnd(12);
    const to = (msg.to === "*" ? "broadcast" : msg.to.slice(0, 12)).padEnd(12);
    console.log(
      `  ${C.gray}${time}${C.reset}  ` +
        `${C.dim}${from}${C.reset} → ${C.dim}${to}${C.reset}  ` +
        `${C.yellow}${msg.type.padEnd(16)}${C.reset}` +
        `${C.gray}  [${msg.id.slice(0, 8)}]${C.reset}`
    );
  }
  console.log();
}

async function cmdDemo() {
  logger.banner(`Harness CLI Demo${isDryRun ? " [DRY RUN]" : ""}`);

  const config = resolveConfig();
  const adapterOptions = { dryRun: true }; // Demo always dry-runs for safety

  const orchestrator = new Orchestrator(config);
  await orchestrator.init(true);

  // Step 1: Discovery
  console.log(`${C.bold}═══ Step 1: Discovering available agents ═══${C.reset}\n`);
  const { available } = orchestrator.discover();
  const anyAvailable = Object.values(available).some(Boolean);
  if (!anyAvailable) {
    console.log(
      `${C.yellow}No CLI tools found — running in full dry-run mode${C.reset}\n`
    );
  }

  // Step 2: Spawn workers (dry-run)
  console.log(`\n${C.bold}═══ Step 2: Spawning workers ═══${C.reset}\n`);
  const workers = orchestrator.spawnWorkers(
    ["claude-code", "codex"],
    config.workDir,
    adapterOptions
  );
  console.log(`  ${C.green}✓${C.reset} Spawned ${workers.length} workers (dry-run mode)\n`);

  // Step 3: Create a plan
  console.log(`${C.bold}═══ Step 3: Creating multi-task plan ═══${C.reset}\n`);

  const tasks: TaskDefinition[] = [
    {
      title: "Analyze project structure",
      description:
        "Read the project directory and understand the codebase layout, key files, and dependencies.",
      priority: "high",
      files: ["package.json", "tsconfig.json", "src/**/*.ts"],
    },
    {
      title: "Generate unit tests",
      description:
        "Based on the project analysis, write unit tests for the core modules.",
      priority: "normal",
      dependsOnIndex: [0],
      files: ["src/**/*.test.ts"],
    },
    {
      title: "Write API documentation",
      description:
        "Generate documentation for the public API surface based on the project analysis.",
      priority: "normal",
      dependsOnIndex: [0],
      files: ["docs/api.md"],
    },
    {
      title: "Review and summarize",
      description:
        "Review the test and documentation outputs and prepare a concise summary.",
      priority: "low",
      dependsOnIndex: [1, 2],
    },
  ];

  await orchestrator.executePlan(
    "Codebase Enhancement Demo",
    "Analyze, test, document, and review.",
    tasks
  );

  // Step 4: Monitor
  console.log(`\n${C.bold}═══ Step 4: Monitoring (press Ctrl+C to stop) ═══${C.reset}\n`);

  process.on("SIGINT", async () => {
    console.log("\n\nStopping demo...\n");
    await orchestrator.shutdown();
    process.exit(0);
  });

  await new Promise<void>((resolve) => {
    const interval = setInterval(() => {
      const planner = orchestrator.getPlanner();
      if (!planner) return;
      const ps = planner.getStatus();
      if (!ps || ps.tasks.total === 0) return;

      const bar = makeProgressBar(ps.tasks.completed, ps.tasks.total, 24);
      process.stdout.write(
        `\r  ${bar} ${ps.tasks.completed}/${ps.tasks.total} tasks` +
          (ps.tasks.active > 0 ? `  ${C.yellow}${ps.tasks.active} active${C.reset}` : "") +
          `  [${colorStatus(ps.status)}]    `
      );

      if (ps.status === "completed" || planner.isPlanFailed()) {
        clearInterval(interval);
        process.stdout.write("\n");
        resolve();
      }
    }, 500);
  });

  logger.banner(
    isDryRun || true ? "Demo complete! (dry-run)" : "Demo complete!"
  );
  console.log(
    `  To run a real plan:\n` +
      `  ${C.cyan}harness plan "My plan" --file examples/plan-refactor-auth.md${C.reset}\n`
  );

  await orchestrator.shutdown();
}

async function cmdClean() {
  const config = resolveConfig();
  const harnessDir = resolveHarnessDir(config);

  if (!existsSync(harnessDir)) {
    console.log("\nNothing to clean — no .harness/ directory.\n");
    return;
  }

  const orchestrator = new Orchestrator(config);
  await orchestrator.init(true);

  const stale = orchestrator.getBus().cleanStaleAgents();
  orchestrator.getBus().cleanOldBroadcasts();

  console.log(
    `\n${C.green}✓ Cleaned${C.reset}: ${stale.length} stale agent(s), old broadcasts removed.\n`
  );
  await orchestrator.shutdown();
}

function showHelp() {
  console.log(`
${C.bold}⬡ Harness CLI${C.reset} — Multi-Agent AI Orchestrator  ${C.gray}alpha${C.reset}

${C.cyan}Usage:${C.reset}
  harness <command> [options]

${C.cyan}Commands:${C.reset}
  init                           Initialize .harness/ and write config
  discover                       Scan for running AI CLI sessions
  status                         Show agents, tasks, and plan status
  agents                         List all registered agents
  run <prompt>                   Execute a prompt via auto-orchestrated agents
  plan <prompt>                  Preview the generated orchestration plan, then execute
  send <agentId> <message>       Send a message to an agent
  watch                          Stream live .harness/ activity
  logs [--tail N]                Show recent message history
  demo                           Run the built-in demo (safe, dry-run)
  clean                          Remove stale agents and old messages

${C.cyan}Advanced:${C.reset}
  spawn <provider>               Start a worker in this terminal

${C.cyan}Options:${C.reset}
  --dir <path>                   Working directory (default: cwd)
  --with <provider>              Force a single provider for 'run' instead of auto-detect
  --tail <n>                     Lines for 'logs' (default: 50)
  --interval <ms>                Refresh rate for 'watch' (default: 1000)
  --timeout <ms>                 Timeout for 'run' (default: 120000)
  --dry-run                      Simulate without calling any AI CLI
  --verbose, -v                  Debug logging

${C.cyan}Providers:${C.reset}
  claude-code    Anthropic Claude Code CLI (claude)
  cursor         Cursor background agent (workspace-inject)
  codex          OpenAI Codex CLI (codex)
  gemini-cli     Google Gemini CLI (gemini)  [coming soon]

${C.cyan}Typical workflow:${C.reset}
  ${C.dim}harness run "implement OAuth login flow"${C.reset}
  ${C.dim}harness plan "@README.md build the missing UX described here"${C.reset}
  ${C.dim}harness watch${C.reset}

${C.cyan}Architecture:${C.reset}
  ┌─────────┐     .harness/          ┌──────────┐
  │ Planner │ ←─ file-based msgs ─→  │  Worker  │ (claude-code)
  └─────────┘                        ├──────────┤
    owns task                        │  Worker  │ (codex)
    scheduling                       └──────────┘
    (no peer                          narrow focus,
    coordination)                     no self-coordination
`);
}

// ─── Helpers ────────────────────────────────────────────────────

const C = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  cyan: "\x1b[36m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
  magenta: "\x1b[35m",
  blue: "\x1b[34m",
  gray: "\x1b[90m",
};

function colorStatus(status: string): string {
  const colors: Record<string, string> = {
    idle: C.green,
    busy: C.yellow,
    offline: C.red,
    active: C.cyan,
    completed: C.green,
    failed: C.red,
    in_progress: C.yellow,
    pending: C.dim,
    assigned: C.blue,
  };
  return `${colors[status] || C.reset}${status}${C.reset}`;
}

function providerColor(provider: string): string {
  const colors: Record<string, string> = {
    "claude-code": C.magenta,
    cursor: C.blue,
    codex: C.green,
    "gemini-cli": C.yellow,
  };
  return colors[provider] || C.cyan;
}

function makeProgressBar(done: number, total: number, width: number): string {
  if (total === 0) return `[${" ".repeat(width)}]`;
  const filled = Math.round((done / total) * width);
  return (
    `${C.green}[${C.reset}` +
    `${C.green}${"█".repeat(filled)}${C.reset}` +
    `${C.dim}${"░".repeat(width - filled)}${C.reset}` +
    `${C.green}]${C.reset}`
  );
}

function readJsonDir(dir: string): unknown[] {
  if (!existsSync(dir)) return [];
  try {
    return readdirSync(dir)
      .filter((f) => f.endsWith(".json"))
      .map((f) => {
        try {
          return JSON.parse(readFileSync(join(dir, f), "utf-8"));
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

// ─── Main (wrapped in async IIFE so all commands can be awaited) ─

(async () => {
  try {
    switch (command) {
      case "init":     await cmdInit();     break;
      case "discover": await cmdDiscover(); break;
      case "status":   await cmdStatus();   break;
      case "spawn":    await cmdSpawn();    break;
      case "agents":   await cmdAgents();   break;
      case "send":     await cmdSend();     break;
      case "plan":     await cmdPlan();     break;
      case "run":      await cmdRun();      break;
      case "watch":    await cmdWatch();    break;
      case "logs":     await cmdLogs();     break;
      case "demo":     await cmdDemo();     break;
      case "clean":    await cmdClean();    break;
      case "help":
      case "--help":
      case "-h":
      case undefined:
        showHelp();
        break;
      default:
        console.error(`${C.red}Unknown command: ${command}${C.reset}`);
        showHelp();
        process.exit(1);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`\n${C.red}✖ Error: ${msg}${C.reset}\n`);
    if (isVerbose) console.error(err);
    process.exit(1);
  }
})();
