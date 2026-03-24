/**
 * File-Based Message Bus
 *
 * All inter-agent communication flows through a shared `.harness/` directory.
 * Structure:
 *
 *   .harness/
 *   ├── agents/          # Agent registration files (one JSON per agent)
 *   ├── tasks/           # Task definition files
 *   ├── messages/
 *   │   ├── inbox/{agentId}/   # Per-agent inbox directories
 *   │   └── broadcast/         # Broadcast messages
 *   ├── plans/           # Plan definitions
 *   ├── locks/           # Simple file-based locks
 *   └── session.json     # Current session state
 *
 * Agents poll their inbox directory for new messages.
 * Processed messages are moved to a `.processed` subdirectory.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, renameSync, unlinkSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Message, AgentInfo, Task, Plan, HarnessSession } from "../core/types";
import { messageId } from "../utils/id";
import { logger } from "../utils/logger";

export class FileBus {
  private baseDir: string;
  private dirs: {
    agents: string;
    tasks: string;
    messages: string;
    inbox: string;
    broadcast: string;
    plans: string;
    locks: string;
  };
  private pollInterval: number;
  private watchers: Map<string, Timer> = new Map();

  constructor(workDir: string, harnessDir: string = ".harness", pollIntervalMs: number = 1000) {
    this.baseDir = join(workDir, harnessDir);
    this.pollInterval = pollIntervalMs;

    this.dirs = {
      agents: join(this.baseDir, "agents"),
      tasks: join(this.baseDir, "tasks"),
      messages: join(this.baseDir, "messages"),
      inbox: join(this.baseDir, "messages", "inbox"),
      broadcast: join(this.baseDir, "messages", "broadcast"),
      plans: join(this.baseDir, "plans"),
      locks: join(this.baseDir, "locks"),
    };
  }

  // ─── Initialization ──────────────────────────────────────────

  initialize(): void {
    for (const dir of Object.values(this.dirs)) {
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }
    }
    logger.debug("File bus initialized", { baseDir: this.baseDir });
  }

  getBaseDir(): string {
    return this.baseDir;
  }

  // ─── Agent Registry ──────────────────────────────────────────

  registerAgent(agent: AgentInfo): void {
    const filePath = join(this.dirs.agents, `${agent.id}.json`);
    writeFileSync(filePath, JSON.stringify(agent, null, 2));

    // Create inbox directory for this agent
    const inboxDir = join(this.dirs.inbox, agent.id);
    if (!existsSync(inboxDir)) {
      mkdirSync(inboxDir, { recursive: true });
    }
    const processedDir = join(inboxDir, ".processed");
    if (!existsSync(processedDir)) {
      mkdirSync(processedDir, { recursive: true });
    }

    logger.agent(agent.provider, `Registered as ${agent.role}`, agent.id);
  }

  unregisterAgent(agentId: string): void {
    const filePath = join(this.dirs.agents, `${agentId}.json`);
    if (existsSync(filePath)) {
      unlinkSync(filePath);
    }
    logger.debug(`Agent unregistered: ${agentId}`);
  }

  getAgent(agentId: string): AgentInfo | null {
    const filePath = join(this.dirs.agents, `${agentId}.json`);
    if (!existsSync(filePath)) return null;
    return JSON.parse(readFileSync(filePath, "utf-8"));
  }

  listAgents(): AgentInfo[] {
    if (!existsSync(this.dirs.agents)) return [];
    return readdirSync(this.dirs.agents)
      .filter((f) => f.endsWith(".json"))
      .map((f) => JSON.parse(readFileSync(join(this.dirs.agents, f), "utf-8")));
  }

  updateAgentStatus(agentId: string, status: AgentInfo["status"]): void {
    const agent = this.getAgent(agentId);
    if (agent) {
      agent.status = status;
      agent.lastHeartbeat = Date.now();
      writeFileSync(join(this.dirs.agents, `${agentId}.json`), JSON.stringify(agent, null, 2));
    }
  }

  heartbeat(agentId: string): void {
    this.updateAgentStatus(agentId, "idle");
  }

  // ─── Messaging ───────────────────────────────────────────────

  send(message: Omit<Message, "id" | "timestamp">): Message {
    const fullMessage: Message = {
      ...message,
      id: messageId(),
      timestamp: Date.now(),
    };

    if (message.to === "*") {
      // Broadcast: write to broadcast directory
      const filePath = join(this.dirs.broadcast, `${fullMessage.id}.json`);
      writeFileSync(filePath, JSON.stringify(fullMessage, null, 2));
    } else {
      // Direct: write to recipient's inbox
      const inboxDir = join(this.dirs.inbox, message.to);
      if (!existsSync(inboxDir)) {
        mkdirSync(inboxDir, { recursive: true });
      }
      const filePath = join(inboxDir, `${fullMessage.id}.json`);
      writeFileSync(filePath, JSON.stringify(fullMessage, null, 2));
    }

    logger.message(message.from, message.to, message.type);
    return fullMessage;
  }

  receive(agentId: string): Message[] {
    const messages: Message[] = [];

    // Check direct inbox
    const inboxDir = join(this.dirs.inbox, agentId);
    if (existsSync(inboxDir)) {
      const files = readdirSync(inboxDir).filter((f) => f.endsWith(".json"));
      for (const file of files) {
        const filePath = join(inboxDir, file);
        try {
          const msg: Message = JSON.parse(readFileSync(filePath, "utf-8"));

          // Check TTL
          if (msg.ttl && Date.now() - msg.timestamp > msg.ttl) {
            unlinkSync(filePath);
            continue;
          }

          messages.push(msg);

          // Move to processed
          const processedDir = join(inboxDir, ".processed");
          if (!existsSync(processedDir)) mkdirSync(processedDir, { recursive: true });
          renameSync(filePath, join(processedDir, file));
        } catch {
          logger.warn(`Failed to read message: ${file}`);
        }
      }
    }

    // Check broadcast messages
    if (existsSync(this.dirs.broadcast)) {
      const files = readdirSync(this.dirs.broadcast).filter((f) => f.endsWith(".json"));
      for (const file of files) {
        const filePath = join(this.dirs.broadcast, file);
        try {
          const msg: Message = JSON.parse(readFileSync(filePath, "utf-8"));
          if (msg.from !== agentId) {
            // Check TTL
            if (msg.ttl && Date.now() - msg.timestamp > msg.ttl) {
              continue; // Don't delete broadcasts, they expire naturally
            }
            messages.push(msg);
          }
        } catch {
          // Skip corrupt messages
        }
      }
    }

    return messages.sort((a, b) => a.timestamp - b.timestamp);
  }

  // Start polling for messages for a specific agent
  startPolling(agentId: string, handler: (messages: Message[]) => void): void {
    if (this.watchers.has(agentId)) return;

    const timer = setInterval(() => {
      const messages = this.receive(agentId);
      if (messages.length > 0) {
        handler(messages);
      }
    }, this.pollInterval);

    this.watchers.set(agentId, timer);
    logger.debug(`Started polling for agent ${agentId}`);
  }

  stopPolling(agentId: string): void {
    const timer = this.watchers.get(agentId);
    if (timer) {
      clearInterval(timer);
      this.watchers.delete(agentId);
    }
  }

  stopAllPolling(): void {
    for (const [id, timer] of this.watchers) {
      clearInterval(timer);
    }
    this.watchers.clear();
  }

  // ─── Task Store ──────────────────────────────────────────────

  saveTask(task: Task): void {
    const filePath = join(this.dirs.tasks, `${task.id}.json`);
    writeFileSync(filePath, JSON.stringify(task, null, 2));
    logger.task(task.id, task.status, task.title);
  }

  getTask(taskId: string): Task | null {
    const filePath = join(this.dirs.tasks, `${taskId}.json`);
    if (!existsSync(filePath)) return null;
    return JSON.parse(readFileSync(filePath, "utf-8"));
  }

  listTasks(): Task[] {
    if (!existsSync(this.dirs.tasks)) return [];
    return readdirSync(this.dirs.tasks)
      .filter((f) => f.endsWith(".json"))
      .map((f) => JSON.parse(readFileSync(join(this.dirs.tasks, f), "utf-8")));
  }

  updateTask(taskId: string, updates: Partial<Task>): Task | null {
    const task = this.getTask(taskId);
    if (!task) return null;
    const updated = { ...task, ...updates, updatedAt: Date.now() };
    this.saveTask(updated);
    return updated;
  }

  // ─── Plan Store ──────────────────────────────────────────────

  savePlan(plan: Plan): void {
    const filePath = join(this.dirs.plans, `${plan.id}.json`);
    writeFileSync(filePath, JSON.stringify(plan, null, 2));
  }

  getPlan(planId: string): Plan | null {
    const filePath = join(this.dirs.plans, `${planId}.json`);
    if (!existsSync(filePath)) return null;
    return JSON.parse(readFileSync(filePath, "utf-8"));
  }

  listPlans(): Plan[] {
    if (!existsSync(this.dirs.plans)) return [];
    return readdirSync(this.dirs.plans)
      .filter((f) => f.endsWith(".json"))
      .map((f) => JSON.parse(readFileSync(join(this.dirs.plans, f), "utf-8")));
  }

  // ─── Session ─────────────────────────────────────────────────

  saveSession(session: HarnessSession): void {
    const filePath = join(this.baseDir, "session.json");
    writeFileSync(filePath, JSON.stringify(session, null, 2));
  }

  getSession(): HarnessSession | null {
    const filePath = join(this.baseDir, "session.json");
    if (!existsSync(filePath)) return null;
    return JSON.parse(readFileSync(filePath, "utf-8"));
  }

  // ─── Cleanup ─────────────────────────────────────────────────

  cleanStaleAgents(timeoutMs: number = 30_000): string[] {
    const stale: string[] = [];
    const agents = this.listAgents();
    const now = Date.now();

    for (const agent of agents) {
      if (now - agent.lastHeartbeat > timeoutMs) {
        this.unregisterAgent(agent.id);
        stale.push(agent.id);
        logger.warn(`Cleaned stale agent: ${agent.id} (${agent.provider})`);
      }
    }

    return stale;
  }

  cleanOldBroadcasts(maxAgeMs: number = 60_000): void {
    if (!existsSync(this.dirs.broadcast)) return;
    const files = readdirSync(this.dirs.broadcast).filter((f) => f.endsWith(".json"));
    const now = Date.now();

    for (const file of files) {
      const filePath = join(this.dirs.broadcast, file);
      try {
        const stat = statSync(filePath);
        if (now - stat.mtimeMs > maxAgeMs) {
          unlinkSync(filePath);
        }
      } catch {
        // Ignore
      }
    }
  }
}
