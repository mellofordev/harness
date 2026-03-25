/**
 * Worker Agent Handler
 *
 * Manages the lifecycle of a worker agent within the harness system.
 * Workers:
 *   1. Register with the file bus
 *   2. Poll for task assignments from the planner
 *   3. Delegate execution to the provider-specific AgentAdapter
 *   4. Report results back to the planner
 *
 * Workers do NOT coordinate with each other — that's the planner's job.
 * Provider-specific logic (prompts, CLI calls, output parsing) lives in
 * src/agents/<provider>.ts, not here. This class stays provider-agnostic.
 */

import type { AgentInfo, AgentProvider, Message, Task, TaskResult } from "../core/types";
import { FileBus } from "../transport/file-bus";
import { getAdapter } from "../agents/index";
import type { AgentAdapter, TaskContext } from "../agents/index";
import { agentId } from "../utils/id";
import { logger } from "../utils/logger";
import type { ScratchpadManager, ScratchpadRef } from "../scratchpad";

export interface WorkerOptions {
  provider: AgentProvider;
  workDir?: string;
  adapterOptions?: Record<string, unknown>;
  scratchpad?: ScratchpadManager;
}

export class Worker {
  private bus: FileBus;
  private agent: AgentInfo;
  private adapter: AgentAdapter;
  private scratchpad: ScratchpadManager | null;
  private currentTask: Task | null = null;
  private running: boolean = false;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;

  constructor(bus: FileBus, options: WorkerOptions) {
    this.bus = bus;
    this.adapter = getAdapter(options.provider, options.adapterOptions);
    this.scratchpad = options.scratchpad ?? null;

    this.agent = {
      id: agentId(options.provider),
      provider: options.provider,
      role: "worker",
      status: "idle",
      capabilities: this.adapter.capabilities,
      registeredAt: Date.now(),
      lastHeartbeat: Date.now(),
      metadata: {
        workDir: options.workDir || process.cwd(),
        adapterDisplayName: this.adapter.displayName,
      },
    };
  }

  // ─── Lifecycle ───────────────────────────────────────────────

  start(): void {
    this.bus.registerAgent(this.agent);
    this.running = true;

    this.bus.startPolling(this.agent.id, (messages) => {
      for (const msg of messages) {
        this.handleMessage(msg);
      }
    });

    this.startHeartbeat();
    logger.agent(
      this.agent.provider,
      `Worker started (${this.adapter.displayName})`,
      this.agent.id
    );
  }

  stop(): void {
    this.running = false;

    // Clear heartbeat first so no more writes happen
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }

    this.bus.stopPolling(this.agent.id);
    this.bus.updateAgentStatus(this.agent.id, "offline");
    logger.agent(this.agent.provider, "Worker stopped", this.agent.id);
  }

  getId(): string {
    return this.agent.id;
  }

  getInfo(): AgentInfo {
    return this.agent;
  }

  getAdapter(): AgentAdapter {
    return this.adapter;
  }

  isBusy(): boolean {
    return this.currentTask !== null;
  }

  // ─── Message Handling ────────────────────────────────────────

  private handleMessage(message: Message): void {
    switch (message.type) {
      case "task_assign":
        // Fire-and-forget but errors are caught inside handleTaskAssignment
        this.handleTaskAssignment(message).catch((err) => {
          logger.error(`Unhandled error in task assignment: ${err}`);
        });
        break;
      case "plan_update":
        this.handlePlanUpdate(message);
        break;
      case "handoff":
        this.handleHandoff(message);
        break;
      case "shutdown":
        logger.info(`Worker ${this.agent.id} received shutdown`);
        this.stop();
        break;
      case "response":
        logger.debug(
          `Response from ${message.from}`,
          message.payload as Record<string, unknown>
        );
        break;
      default:
        logger.debug(`Worker ${this.agent.id} ignoring message type: ${message.type}`);
    }
  }

  private async handleTaskAssignment(message: Message): Promise<void> {
    const { task, context: planContext } = message.payload as {
      task: Task;
      context: Record<string, unknown>;
    };

    if (this.currentTask) {
      logger.warn(`Worker ${this.agent.id} already busy — rejecting ${task.id}`);
      this.bus.send({
        type: "task_failed",
        from: this.agent.id,
        to: message.from,
        payload: { taskId: task.id, error: "Worker already busy" },
      });
      return;
    }

    this.currentTask = task;
    this.bus.updateAgentStatus(this.agent.id, "busy");

    // Initialize agent scratchpad and record task start
    if (this.scratchpad) {
      this.scratchpad.initAgent(this.agent.id);
      this.scratchpad.appendSection(this.agent.id, "status",
        `[in_progress] Starting: ${task.title}`, task.id);
    }

    // Notify planner we've started
    this.bus.send({
      type: "task_update",
      from: this.agent.id,
      to: message.from,
      payload: { taskId: task.id, status: "in_progress", progress: "Starting execution" },
    });

    try {
      const taskContext: TaskContext = {
        workDir: (this.agent.metadata.workDir as string) || process.cwd(),
        dependencyResults: {},
        planTitle: planContext.planTitle as string | undefined,
        planDescription: planContext.planDescription as string | undefined,
        handoffContext: this.agent.metadata.handoffContext as
          | Record<string, unknown>
          | undefined,
      };

      // Scratchpad path: read context on-demand from scratchpad files
      if (planContext.scratchpadRefs && this.scratchpad) {
        taskContext.scratchpadContext = this.scratchpad.buildPromptContext(
          planContext.scratchpadRefs as ScratchpadRef[]
        );
        taskContext.scratchpadPath = this.scratchpad.getRef(this.agent.id)?.scratchpadPath;
      } else if (planContext.dependencyResults) {
        // Legacy path: inline TaskResult objects
        taskContext.dependencyResults =
          (planContext.dependencyResults as Record<string, TaskResult>) || {};
      }

      // All provider-specific logic is in the adapter — worker stays generic
      const result = await this.adapter.execute(task, taskContext);

      // Update agent scratchpad with completion data
      if (this.scratchpad) {
        this.scratchpad.appendSection(this.agent.id, "status",
          `[completed] ${task.title}: ${result.summary}`, task.id);
        if (result.filesChanged.length > 0) {
          this.scratchpad.replaceSection(this.agent.id, "files_changed",
            result.filesChanged.map((f) => `- ${f}`).join("\n"));
        }
      }

      this.bus.send({
        type: "task_complete",
        from: this.agent.id,
        to: message.from,
        payload: { taskId: task.id, result },
      });

      logger.info(`Task completed: ${task.title}`, {
        taskId: task.id,
        provider: this.agent.provider,
        success: result.success,
      });
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);

      // Record failure in scratchpad
      if (this.scratchpad) {
        this.scratchpad.appendSection(this.agent.id, "blockers",
          `Task "${task.title}" failed: ${error}`, task.id);
      }

      this.bus.send({
        type: "task_failed",
        from: this.agent.id,
        to: message.from,
        payload: { taskId: task.id, error },
      });
      logger.error(`Task failed: ${task.title}`, { taskId: task.id, error });
    } finally {
      this.currentTask = null;
      this.bus.updateAgentStatus(this.agent.id, "idle");
    }
  }

  private handlePlanUpdate(message: Message): void {
    const { status } = message.payload as { status: string };
    if (status === "completed") {
      logger.info(`Worker ${this.agent.id}: plan completed, going idle`);
    }
  }

  private handleHandoff(message: Message): void {
    const { context, instructions } = message.payload as {
      context: Record<string, unknown>;
      instructions: string;
    };
    logger.info(`Handoff from ${message.from}: ${instructions}`);
    this.agent.metadata.handoffContext = context;
  }

  // ─── Inter-Worker Communication ──────────────────────────────

  /**
   * Pass context to another worker after completing a subtask.
   * The planner still owns scheduling — this is context enrichment only.
   */
  handoffTo(
    targetAgentId: string,
    context: Record<string, unknown>,
    instructions: string
  ): void {
    this.bus.send({
      type: "handoff",
      from: this.agent.id,
      to: targetAgentId,
      payload: { context, instructions },
    });
    logger.message(this.agent.id, targetAgentId, "handoff");
  }

  /**
   * Ask the planner (or another agent) a question.
   */
  query(targetAgentId: string, question: string): void {
    this.bus.send({
      type: "query",
      from: this.agent.id,
      to: targetAgentId,
      payload: { question },
    });
  }

  // ─── Heartbeat ───────────────────────────────────────────────

  private startHeartbeat(): void {
    this.heartbeatTimer = setInterval(() => {
      if (!this.running) {
        if (this.heartbeatTimer) {
          clearInterval(this.heartbeatTimer);
          this.heartbeatTimer = null;
        }
        return;
      }
      this.bus.heartbeat(this.agent.id);
    }, 5000);
  }
}
