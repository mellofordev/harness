/**
 * Harness Orchestrator
 *
 * The central coordination engine that brings together:
 *   - Agent discovery
 *   - File-based message bus
 *   - Hierarchical planner/worker model
 *   - CLI agent spawning
 *
 * This is the main runtime — the CLI commands delegate to this.
 */

import { resolve, join } from "node:path";
import type { AgentInfo, AgentProvider, HarnessConfig, HarnessSession } from "./types";
import { FileBus } from "../transport/file-bus";
import { Planner, type TaskDefinition } from "../planner/planner";
import { Worker } from "../planner/worker";
import { discoverAgents, checkCliAvailability } from "../discovery/detector";
import { sessionId, agentId } from "../utils/id";
import { logger } from "../utils/logger";

export class Orchestrator {
  private config: HarnessConfig;
  private bus: FileBus;
  private planner: Planner | null = null;
  private plannerId: string | null = null;
  private workers: Map<string, Worker> = new Map();
  private session: HarnessSession | null = null;
  private schedulerTimer: ReturnType<typeof setInterval> | null = null;

  constructor(config: HarnessConfig) {
    this.config = config;
    this.bus = new FileBus(config.workDir, config.harnessDir, config.pollIntervalMs);
  }

  // ─── Session Management ──────────────────────────────────────

  async init(silent = false): Promise<void> {
    if (!silent) logger.banner("Harness CLI — Multi-Agent Orchestrator");

    this.bus.initialize();

    this.session = {
      id: sessionId(),
      workDir: resolve(this.config.workDir),
      harnessDir: join(resolve(this.config.workDir), this.config.harnessDir),
      agents: [],
      plans: [],
      startedAt: Date.now(),
      status: "active",
    };

    this.bus.saveSession(this.session);
    if (!silent) {
      logger.info(`Session started: ${this.session.id}`, { workDir: this.session.workDir });
    }
  }

  async shutdown(): Promise<void> {
    // Stop scheduler first
    if (this.schedulerTimer) {
      clearInterval(this.schedulerTimer);
      this.schedulerTimer = null;
    }

    // Broadcast shutdown to all workers
    if (this.plannerId) {
      this.bus.send({
        type: "shutdown",
        from: this.plannerId,
        to: "*",
        payload: { reason: "orchestrator shutdown" },
      });
    }

    // Give workers a beat to receive the message, then stop them
    await new Promise((r) => setTimeout(r, 200));

    for (const worker of this.workers.values()) {
      worker.stop();
    }
    this.workers.clear();

    this.bus.stopAllPolling();

    if (this.session) {
      this.session.status = "completed";
      this.bus.saveSession(this.session);
    }

    logger.info("Orchestrator shut down cleanly");
  }

  // ─── Discovery ───────────────────────────────────────────────

  discover(): {
    running: ReturnType<typeof discoverAgents>;
    available: ReturnType<typeof checkCliAvailability>;
  } {
    logger.info("Discovering agents...");
    const running = discoverAgents();
    const available = checkCliAvailability();

    const availableList = Object.entries(available)
      .filter(([, v]) => v)
      .map(([k]) => k);

    if (availableList.length > 0) {
      logger.info(`Available CLIs: ${availableList.join(", ")}`);
    } else {
      logger.warn("No AI CLI tools found on PATH");
    }

    return { running, available };
  }

  // ─── Planner Setup ───────────────────────────────────────────

  createPlanner(): Planner {
    // Guard: don't create a second planner if one already exists
    if (this.planner) return this.planner;

    const id = agentId("planner");
    this.plannerId = id;

    const plannerAgent: AgentInfo = {
      id,
      provider: "claude-code",
      role: "planner",
      status: "idle",
      capabilities: ["planning", "decomposition", "coordination"],
      registeredAt: Date.now(),
      lastHeartbeat: Date.now(),
      metadata: {},
    };

    this.bus.registerAgent(plannerAgent);

    this.planner = new Planner(this.bus, id, {
      maxConcurrentWorkers: this.config.maxConcurrentWorkers,
      taskTimeoutMs: this.config.taskTimeoutMs,
    });

    // Start polling for incoming messages to the planner
    this.bus.startPolling(id, (messages) => {
      for (const msg of messages) {
        this.planner!.handleMessage(msg);
      }
    });

    logger.info(`Planner created: ${id}`);
    return this.planner;
  }

  // ─── Worker Management ───────────────────────────────────────

  spawnWorker(
    provider: AgentProvider,
    workDir?: string,
    adapterOptions?: Record<string, unknown>
  ): Worker {
    const worker = new Worker(this.bus, {
      provider,
      workDir: workDir || this.config.workDir,
      adapterOptions,
    });

    worker.start();
    this.workers.set(worker.getId(), worker);
    logger.agent(provider, "Worker spawned", worker.getId());
    return worker;
  }

  spawnWorkers(
    providers: AgentProvider[],
    workDir?: string,
    adapterOptions?: Record<string, unknown>
  ): Worker[] {
    return providers.map((p) => this.spawnWorker(p, workDir, adapterOptions));
  }

  getWorkers(): Map<string, Worker> {
    return this.workers;
  }

  // ─── Plan Execution ──────────────────────────────────────────

  async executePlan(
    title: string,
    description: string,
    tasks: TaskDefinition[]
  ): Promise<void> {
    // Ensure planner exists (idempotent)
    this.createPlanner();

    // Guard against double-starting the scheduler
    if (this.schedulerTimer) {
      clearInterval(this.schedulerTimer);
      this.schedulerTimer = null;
    }

    const plan = this.planner!.createPlan(title, description, tasks);
    logger.info(`Plan "${title}" created with ${tasks.length} tasks, starting scheduler...`);

    this.schedulerTimer = setInterval(() => {
      if (!this.planner) return;

      this.planner.schedule();
      const planStatus = this.planner.getStatus();

      if (planStatus.status === "completed") {
        logger.banner("✓ All tasks completed!");
        if (this.schedulerTimer) {
          clearInterval(this.schedulerTimer);
          this.schedulerTimer = null;
        }
      } else if (this.planner.isPlanFailed()) {
        logger.error("Plan ended with failed tasks");
        if (this.schedulerTimer) {
          clearInterval(this.schedulerTimer);
          this.schedulerTimer = null;
        }
      }
    }, this.config.pollIntervalMs * 2);
  }

  // ─── Status ──────────────────────────────────────────────────

  getStatus(): {
    session: HarnessSession | null;
    agents: AgentInfo[];
    planStatus: ReturnType<Planner["getStatus"]> | null;
  } {
    return {
      session: this.session,
      agents: this.bus.listAgents(),
      planStatus: this.planner?.getStatus() ?? null,
    };
  }

  getBus(): FileBus {
    return this.bus;
  }

  getPlanner(): Planner | null {
    return this.planner;
  }

  getConfig(): HarnessConfig {
    return this.config;
  }
}
