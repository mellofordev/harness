/**
 * Hierarchical Planner
 *
 * Implements the recursive planner/worker architecture:
 *
 *   1. Root Planner decomposes a high-level goal into tasks
 *   2. Tasks are assigned to available worker agents
 *   3. Workers execute on isolated copies and report back
 *   4. Planner monitors progress, reassigns on failure, merges results
 *
 * Key design from Cursor's architecture:
 *   - Single planner owns coordination (no self-coordination between workers)
 *   - Workers have narrow focus — they don't manage coordination
 *   - Clear handoff protocols between planner and workers
 */

import type { Task, Plan, AgentInfo, Message, TaskResult, TaskPriority } from "../core/types";
import { FileBus } from "../transport/file-bus";
import { taskId, planId } from "../utils/id";
import { logger } from "../utils/logger";
import type { ScratchpadManager } from "../scratchpad";
import type { ScratchpadRef } from "../scratchpad";

export interface PlannerOptions {
  maxConcurrentWorkers: number;
  taskTimeoutMs: number;
  retryFailedTasks: boolean;
  maxRetries: number;
}

const DEFAULT_OPTIONS: PlannerOptions = {
  maxConcurrentWorkers: 5,
  taskTimeoutMs: 300_000,
  retryFailedTasks: true,
  maxRetries: 2,
};

export class Planner {
  private bus: FileBus;
  private plannerId: string;
  private options: PlannerOptions;
  private activePlan: Plan | null = null;
  private retryCount: Map<string, number> = new Map();
  private scratchpad: ScratchpadManager | null;

  constructor(bus: FileBus, plannerId: string, options?: Partial<PlannerOptions>, scratchpad?: ScratchpadManager) {
    this.bus = bus;
    this.plannerId = plannerId;
    this.options = { ...DEFAULT_OPTIONS, ...options };
    this.scratchpad = scratchpad ?? null;
  }

  // ─── Plan Creation ───────────────────────────────────────────

  createPlan(title: string, description: string, taskDefs: TaskDefinition[]): Plan {
    const tasks: Task[] = taskDefs.map((def, index) => ({
      id: taskId(),
      parentId: def.parentId,
      title: def.title,
      description: def.description,
      status: "pending",
      priority: def.priority || "normal",
      createdBy: this.plannerId,
      dependencies: def.dependencies || [],
      files: def.files || [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }));

    // Resolve dependency references by index to actual IDs
    for (let i = 0; i < taskDefs.length; i++) {
      if (taskDefs[i].dependsOnIndex) {
        tasks[i].dependencies = taskDefs[i].dependsOnIndex!.map((idx) => tasks[idx].id);
      }
    }

    const plan: Plan = {
      id: planId(),
      title,
      description,
      rootTaskId: tasks[0]?.id || "",
      tasks,
      createdBy: this.plannerId,
      status: "active",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    // Persist everything
    this.bus.savePlan(plan);
    for (const task of tasks) {
      this.bus.saveTask(task);
    }

    this.activePlan = plan;
    logger.info(`Plan created: ${plan.title}`, { id: plan.id, tasks: tasks.length });

    return plan;
  }

  // ─── Task Assignment ─────────────────────────────────────────

  /**
   * Find tasks that are ready to be assigned (all dependencies met)
   */
  getReadyTasks(): Task[] {
    if (!this.activePlan) return [];

    return this.activePlan.tasks.filter((task) => {
      if (task.status !== "pending") return false;

      // Check all dependencies are completed
      return task.dependencies.every((depId) => {
        const depTask = this.activePlan!.tasks.find((t) => t.id === depId);
        return depTask?.status === "completed";
      });
    });
  }

  /**
   * Find idle workers that can accept tasks
   */
  getAvailableWorkers(): AgentInfo[] {
    return this.bus
      .listAgents()
      .filter(
        (agent) =>
          agent.role === "worker" &&
          (agent.status === "idle" || agent.status === "waiting") &&
          agent.id !== this.plannerId
      );
  }

  /**
   * Assign a task to a specific worker agent
   */
  assignTask(task: Task, worker: AgentInfo): void {
    // Update task state
    task.status = "assigned";
    task.assignedTo = worker.id;
    task.updatedAt = Date.now();
    this.bus.saveTask(task);

    // Update worker status
    this.bus.updateAgentStatus(worker.id, "busy");

    // Send task assignment message
    this.bus.send({
      type: "task_assign",
      from: this.plannerId,
      to: worker.id,
      payload: {
        task,
        context: this.gatherTaskContext(task),
      },
    });

    logger.agent(worker.provider, `Assigned: ${task.title}`, task.id);
  }

  /**
   * Run one scheduling cycle: match ready tasks to available workers
   */
  schedule(): { assigned: number; pending: number; blocked: number } {
    const readyTasks = this.getReadyTasks();
    const workers = this.getAvailableWorkers();

    let assigned = 0;
    const maxToAssign = Math.min(
      readyTasks.length,
      workers.length,
      this.options.maxConcurrentWorkers - this.getActiveWorkerCount()
    );

    // Assign by priority (critical first)
    const priorityOrder: TaskPriority[] = ["critical", "high", "normal", "low"];
    const sortedTasks = readyTasks.sort(
      (a, b) => priorityOrder.indexOf(a.priority) - priorityOrder.indexOf(b.priority)
    );

    for (let i = 0; i < maxToAssign; i++) {
      this.assignTask(sortedTasks[i], workers[i]);
      assigned++;
    }

    const allTasks = this.activePlan?.tasks || [];
    const pending = allTasks.filter((t) => t.status === "pending").length;
    const blocked = pending - readyTasks.length;

    return { assigned, pending, blocked };
  }

  // ─── Message Handling ────────────────────────────────────────

  handleMessage(message: Message): void {
    switch (message.type) {
      case "task_complete":
        this.handleTaskComplete(message);
        break;
      case "task_failed":
        this.handleTaskFailed(message);
        break;
      case "task_update":
        this.handleTaskUpdate(message);
        break;
      case "query":
        this.handleQuery(message);
        break;
      default:
        logger.debug(`Planner received unhandled message type: ${message.type}`);
    }
  }

  private handleTaskComplete(message: Message): void {
    const { taskId: tId, result } = message.payload as { taskId: string; result: TaskResult };

    this.bus.updateTask(tId, {
      status: "completed",
      result,
      completedAt: Date.now(),
    });

    // Update agent status back to idle
    this.bus.updateAgentStatus(message.from, "idle");

    // Update local plan state
    if (this.activePlan) {
      const task = this.activePlan.tasks.find((t) => t.id === tId);
      if (task) {
        task.status = "completed";
        task.result = result;
        task.completedAt = Date.now();
      }
      this.activePlan.updatedAt = Date.now();
      this.bus.savePlan(this.activePlan);
    }

    // Write completion data to scratchpads
    if (this.scratchpad) {
      const taskTitle = this.activePlan?.tasks.find((t) => t.id === tId)?.title || tId;
      this.scratchpad.appendSection(message.from, "status",
        `[completed] ${taskTitle}: ${result.summary}`);
      if (result.filesChanged.length > 0) {
        this.scratchpad.replaceSection(message.from, "files_changed",
          result.filesChanged.map((f) => `- ${f}`).join("\n"));
      }
      this.scratchpad.updateProjectPad("status",
        `Task "${taskTitle}" completed by ${message.from}: ${result.summary}`);
    }

    logger.info(`Task completed: ${tId}`, { by: message.from, success: result.success });

    // Check if plan is fully completed
    if (this.isPlanComplete()) {
      this.completePlan();
    }
  }

  private handleTaskFailed(message: Message): void {
    const { taskId: tId, error } = message.payload as { taskId: string; error: string };

    this.bus.updateAgentStatus(message.from, "idle");

    // Retry logic
    const retries = this.retryCount.get(tId) || 0;
    if (this.options.retryFailedTasks && retries < this.options.maxRetries) {
      this.retryCount.set(tId, retries + 1);
      this.bus.updateTask(tId, { status: "pending", assignedTo: undefined });

      if (this.activePlan) {
        const task = this.activePlan.tasks.find((t) => t.id === tId);
        if (task) {
          task.status = "pending";
          task.assignedTo = undefined;
        }
      }

      logger.warn(`Task ${tId} failed, retrying (${retries + 1}/${this.options.maxRetries}): ${error}`);
    } else {
      this.bus.updateTask(tId, {
        status: "failed",
        result: { success: false, summary: error, filesChanged: [], errors: [error] },
      });

      if (this.activePlan) {
        const task = this.activePlan.tasks.find((t) => t.id === tId);
        if (task) {
          task.status = "failed";
        }
      }

      logger.error(`Task ${tId} permanently failed: ${error}`);
    }
  }

  private handleTaskUpdate(message: Message): void {
    const { taskId: tId, status, progress } = message.payload as {
      taskId: string;
      status: string;
      progress?: string;
    };

    this.bus.updateTask(tId, { status: status as Task["status"] });
    logger.debug(`Task ${tId} update from ${message.from}: ${progress || status}`);
  }

  private handleQuery(message: Message): void {
    const { question } = message.payload as { question: string };
    logger.info(`Query from ${message.from}: ${question}`);

    // Auto-respond with plan context
    this.bus.send({
      type: "response",
      from: this.plannerId,
      to: message.from,
      payload: {
        answer: `Current plan: ${this.activePlan?.title || "none"}. Active tasks: ${this.getActiveWorkerCount()}`,
        plan: this.activePlan ? { id: this.activePlan.id, status: this.activePlan.status } : null,
      },
      correlationId: message.id,
    });
  }

  // ─── Plan Status ─────────────────────────────────────────────

  isPlanComplete(): boolean {
    if (!this.activePlan) return false;
    return this.activePlan.tasks.every(
      (t) => t.status === "completed" || t.status === "cancelled"
    );
  }

  isPlanFailed(): boolean {
    if (!this.activePlan) return false;
    return this.activePlan.tasks.some((t) => t.status === "failed");
  }

  private completePlan(): void {
    if (!this.activePlan) return;
    this.activePlan.status = "completed";
    this.activePlan.updatedAt = Date.now();
    this.bus.savePlan(this.activePlan);

    // Broadcast completion
    this.bus.send({
      type: "plan_update",
      from: this.plannerId,
      to: "*",
      payload: { planId: this.activePlan.id, status: "completed" },
    });

    logger.banner(`Plan completed: ${this.activePlan.title}`);
  }

  getStatus(): PlanStatus {
    if (!this.activePlan) {
      return { planId: null, status: "no_plan", tasks: { total: 0, pending: 0, active: 0, completed: 0, failed: 0 } };
    }

    const tasks = this.activePlan.tasks;
    return {
      planId: this.activePlan.id,
      status: this.activePlan.status,
      tasks: {
        total: tasks.length,
        pending: tasks.filter((t) => t.status === "pending").length,
        active: tasks.filter((t) => t.status === "assigned" || t.status === "in_progress").length,
        completed: tasks.filter((t) => t.status === "completed").length,
        failed: tasks.filter((t) => t.status === "failed").length,
      },
    };
  }

  // ─── Helpers ─────────────────────────────────────────────────

  private getActiveWorkerCount(): number {
    return this.bus.listAgents().filter((a) => a.role === "worker" && a.status === "busy").length;
  }

  private gatherTaskContext(task: Task): Record<string, unknown> {
    // Scratchpad path: send lightweight refs instead of full TaskResult objects
    if (this.scratchpad) {
      const scratchpadRefs: ScratchpadRef[] = [];
      for (const depId of task.dependencies) {
        const depTask = this.bus.getTask(depId);
        if (depTask?.assignedTo) {
          const ref = this.scratchpad.getRef(depTask.assignedTo);
          if (ref) scratchpadRefs.push(ref);
        }
      }
      return {
        planTitle: this.activePlan?.title,
        planDescription: this.activePlan?.description,
        scratchpadRefs,
        projectScratchpadPath: this.scratchpad.getProjectPadPath(),
        totalTasks: this.activePlan?.tasks.length || 0,
      };
    }

    // Legacy path: full TaskResult objects
    const depResults: Record<string, TaskResult> = {};
    for (const depId of task.dependencies) {
      const depTask = this.bus.getTask(depId);
      if (depTask?.result) {
        depResults[depId] = depTask.result;
      }
    }

    return {
      planTitle: this.activePlan?.title,
      planDescription: this.activePlan?.description,
      dependencyResults: depResults,
      totalTasks: this.activePlan?.tasks.length || 0,
    };
  }
}

// ─── Supporting Types ──────────────────────────────────────────

export interface TaskDefinition {
  title: string;
  description: string;
  priority?: TaskPriority;
  parentId?: string;
  dependencies?: string[];
  dependsOnIndex?: number[];  // Resolved during plan creation
  files?: string[];
}

export interface PlanStatus {
  planId: string | null;
  status: string;
  tasks: {
    total: number;
    pending: number;
    active: number;
    completed: number;
    failed: number;
  };
}
