/**
 * Harness Watch Command
 *
 * Streams real-time activity from the .harness/ directory to the terminal.
 * Polls agents, tasks, messages, and plans — printing a live dashboard.
 *
 * Designed for use in a third terminal while a plan runs in terminal 1
 * and a worker runs in terminal 2:
 *
 *   Terminal 1: harness plan "Refactor" --file plan.json
 *   Terminal 2: harness spawn claude-code
 *   Terminal 3: harness watch       ← you are here
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { AgentInfo, Task, Message, Plan } from "../core/types";
import { logger } from "../utils/logger";

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

const STATUS_COLORS: Record<string, string> = {
  idle: C.green,
  busy: C.yellow,
  offline: C.red,
  waiting: C.blue,
  pending: C.dim,
  assigned: C.blue,
  in_progress: C.yellow,
  completed: C.green,
  failed: C.red,
  active: C.cyan,
};

function colorStatus(status: string): string {
  const color = STATUS_COLORS[status] || C.reset;
  return `${color}${status}${C.reset}`;
}

interface WatchState {
  lastMessageIds: Set<string>;
  lastTaskStates: Map<string, string>;
  lastAgentStates: Map<string, string>;
}

export function startWatch(harnessDir: string, refreshMs = 1000): () => void {
  if (!existsSync(harnessDir)) {
    logger.error(`No .harness directory found at: ${harnessDir}`);
    logger.info("Run 'harness init' first, then start a plan.");
    process.exit(1);
  }

  const state: WatchState = {
    lastMessageIds: new Set(),
    lastTaskStates: new Map(),
    lastAgentStates: new Map(),
  };

  // Print the static header once
  printHeader(harnessDir);

  const interval = setInterval(() => {
    tick(harnessDir, state);
  }, refreshMs);

  // First tick immediately
  tick(harnessDir, state);

  return () => clearInterval(interval);
}

function printHeader(harnessDir: string) {
  console.clear();
  console.log(
    `${C.bold}${C.cyan}⬡ Harness Watch${C.reset}  ${C.gray}${harnessDir}${C.reset}`
  );
  console.log(`${C.gray}${"─".repeat(60)}${C.reset}`);
  console.log(
    `${C.dim}Streaming activity from .harness/ — Ctrl+C to stop${C.reset}\n`
  );
}

function tick(harnessDir: string, state: WatchState) {
  const agents = readJsonDir<AgentInfo>(join(harnessDir, "agents"));
  const tasks = readJsonDir<Task>(join(harnessDir, "tasks"));
  const plans = readJsonDir<Plan>(join(harnessDir, "plans"));

  // ─── Print agent changes ─────────────────────────────────────
  for (const agent of agents) {
    const prev = state.lastAgentStates.get(agent.id);
    if (prev !== agent.status) {
      const ago = formatAge(agent.lastHeartbeat);
      const provColor = providerColor(agent.provider);
      console.log(
        `${C.gray}${timestamp()}${C.reset}  ` +
          `${provColor}⬡ ${agent.provider}${C.reset} ${C.dim}[${agent.id.slice(0, 8)}]${C.reset} ` +
          `${prev ? `${colorStatus(prev)} → ` : ""}${colorStatus(agent.status)} ` +
          `${C.gray}(${agent.role}, seen ${ago})${C.reset}`
      );
      state.lastAgentStates.set(agent.id, agent.status);
    }
  }

  // ─── Print task changes ──────────────────────────────────────
  for (const task of tasks) {
    const prev = state.lastTaskStates.get(task.id);
    if (prev !== task.status) {
      const assignee = task.assignedTo
        ? ` → ${C.dim}${task.assignedTo.slice(0, 8)}${C.reset}`
        : "";
      console.log(
        `${C.gray}${timestamp()}${C.reset}  ` +
          `${C.bold}◆ task${C.reset} ${C.dim}[${task.id.slice(0, 8)}]${C.reset} ` +
          `${prev ? `${colorStatus(prev)} → ` : ""}${colorStatus(task.status)} ` +
          `${C.cyan}"${task.title.slice(0, 50)}"${C.reset}${assignee}`
      );
      state.lastTaskStates.set(task.id, task.status);
    }
  }

  // ─── Print new messages ──────────────────────────────────────
  const allMsgs = readNewMessages(harnessDir, state.lastMessageIds);
  for (const msg of allMsgs) {
    if (!state.lastMessageIds.has(msg.id)) {
      const from = msg.from.slice(0, 8);
      const to = msg.to === "*" ? "broadcast" : msg.to.slice(0, 8);
      console.log(
        `${C.gray}${timestamp()}${C.reset}  ` +
          `${C.magenta}✉ msg${C.reset} ${C.dim}${from} → ${to}${C.reset} ` +
          `${C.yellow}${msg.type}${C.reset}`
      );
      state.lastMessageIds.add(msg.id);
    }
  }

  // ─── Print plan summary if active ───────────────────────────
  for (const plan of plans) {
    if (plan.status === "active") {
      const done = plan.tasks.filter((t) => t.status === "completed").length;
      const total = plan.tasks.length;
      const failed = plan.tasks.filter((t) => t.status === "failed").length;
      const bar = makeProgressBar(done, total, 20);
      process.stdout.write(
        `\r${C.gray}Plan: ${C.reset}${C.bold}${plan.title.slice(0, 30)}${C.reset}  ` +
          `${bar} ${done}/${total}` +
          (failed > 0 ? `  ${C.red}${failed} failed${C.reset}` : "") +
          "   "
      );
    }
  }
}

// ─── Helpers ────────────────────────────────────────────────────

function readJsonDir<T>(dir: string): T[] {
  if (!existsSync(dir)) return [];
  try {
    return readdirSync(dir)
      .filter((f) => f.endsWith(".json"))
      .map((f) => {
        try {
          return JSON.parse(readFileSync(join(dir, f), "utf-8")) as T;
        } catch {
          return null;
        }
      })
      .filter(Boolean) as T[];
  } catch {
    return [];
  }
}

function readNewMessages(harnessDir: string, seen: Set<string>): Message[] {
  const msgs: Message[] = [];

  // Processed inboxes
  const inboxDir = join(harnessDir, "messages", "inbox");
  if (existsSync(inboxDir)) {
    for (const agentDir of readdirSync(inboxDir)) {
      const processedDir = join(inboxDir, agentDir, ".processed");
      if (existsSync(processedDir)) {
        for (const f of readdirSync(processedDir).filter((f) => f.endsWith(".json"))) {
          try {
            const msg: Message = JSON.parse(
              readFileSync(join(processedDir, f), "utf-8")
            );
            if (!seen.has(msg.id)) msgs.push(msg);
          } catch {
            // Skip
          }
        }
      }
    }
  }

  // Broadcast
  const broadcastDir = join(harnessDir, "messages", "broadcast");
  if (existsSync(broadcastDir)) {
    for (const f of readdirSync(broadcastDir).filter((f) => f.endsWith(".json"))) {
      try {
        const msg: Message = JSON.parse(
          readFileSync(join(broadcastDir, f), "utf-8")
        );
        if (!seen.has(msg.id)) msgs.push(msg);
      } catch {
        // Skip
      }
    }
  }

  return msgs.sort((a, b) => a.timestamp - b.timestamp);
}

function timestamp(): string {
  return new Date().toISOString().split("T")[1].slice(0, 12);
}

function formatAge(ts: number): string {
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  return `${Math.round(s / 3600)}h ago`;
}

function makeProgressBar(done: number, total: number, width: number): string {
  if (total === 0) return `[${" ".repeat(width)}]`;
  const filled = Math.round((done / total) * width);
  return (
    `${C.green}[${C.reset}` +
    `${C.green}${"█".repeat(filled)}${C.reset}` +
    `${C.gray}${"░".repeat(width - filled)}${C.reset}` +
    `${C.green}]${C.reset}`
  );
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
