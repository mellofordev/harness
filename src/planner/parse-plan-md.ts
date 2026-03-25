/**
 * Markdown Plan Parser
 *
 * Parses a human-friendly markdown plan into structured TaskDefinitions.
 *
 * Format:
 *
 *   # Plan Title (ignored — title comes from CLI arg)
 *
 *   Description text here.
 *
 *   Workers: claude-code, codex
 *
 *   ## Task 1: Audit current auth [high]
 *   Detailed description of the task.
 *   Can span multiple lines.
 *   Files: src/auth/**, src/middleware/auth.ts
 *   Depends on: 1
 *
 *   ## Task 2: Implement JWT [normal]
 *   Another task description.
 *   Files: src/auth/jwt.ts
 *   Depends on: 1
 */

import type { TaskDefinition } from "./planner";
import type { AgentProvider, TaskPriority } from "../core/types";

export interface ParsedPlan {
  description: string;
  workers: AgentProvider[];
  tasks: TaskDefinition[];
}

const VALID_PRIORITIES = ["critical", "high", "normal", "low"] as const;
const VALID_PROVIDERS: AgentProvider[] = ["claude-code", "codex", "cursor", "gemini-cli"];

export function parsePlanMarkdown(md: string): ParsedPlan {
  const lines = md.split("\n");

  let description = "";
  const descLines: string[] = [];
  let workers: AgentProvider[] = [];
  const tasks: TaskDefinition[] = [];

  let currentTask: Partial<TaskDefinition> & { descLines: string[]; depsRaw: number[] } | null = null;

  function flushTask() {
    if (!currentTask) return;
    const taskDesc = currentTask.descLines.join("\n").trim();
    tasks.push({
      title: currentTask.title!,
      description: taskDesc || currentTask.title!,
      priority: currentTask.priority || "normal",
      ...(currentTask.files && currentTask.files.length > 0 ? { files: currentTask.files } : {}),
      ...(currentTask.depsRaw.length > 0 ? { dependsOnIndex: currentTask.depsRaw } : {}),
    });
    currentTask = null;
  }

  let inHeader = true; // before any ## task heading

  for (const rawLine of lines) {
    const line = rawLine;

    // ── H2: Task heading ──
    const taskMatch = line.match(/^##\s+(?:Task\s+\d+\s*:\s*)?(.+?)(?:\s*\[(\w+)\])?\s*$/i);
    if (taskMatch) {
      flushTask();
      inHeader = false;
      const title = taskMatch[1].trim();
      const priority = taskMatch[2]?.toLowerCase();
      currentTask = {
        title,
        priority: VALID_PRIORITIES.includes(priority as any) ? (priority as TaskPriority) : "normal",
        descLines: [],
        depsRaw: [],
      };
      continue;
    }

    // ── H1: Plan title (ignored, title comes from CLI arg) ──
    if (line.match(/^#\s+/) && !line.startsWith("##")) {
      continue;
    }

    // ── Inside a task block ──
    if (currentTask) {
      // Files: line
      const filesMatch = line.match(/^Files\s*:\s*(.+)/i);
      if (filesMatch) {
        currentTask.files = filesMatch[1].split(",").map((f) => f.trim()).filter(Boolean);
        continue;
      }

      // Depends on: line
      const depsMatch = line.match(/^Depends\s+on\s*:\s*(.+)/i);
      if (depsMatch) {
        currentTask.depsRaw = depsMatch[1]
          .split(",")
          .map((n) => parseInt(n.trim(), 10) - 1)
          .filter((n) => n >= 0);
        continue;
      }

      // Regular description line
      currentTask.descLines.push(line);
      continue;
    }

    // ── Header section (before any task) ──
    if (inHeader) {
      // Workers: line
      const workersMatch = line.match(/^Workers\s*:\s*(.+)/i);
      if (workersMatch) {
        workers = workersMatch[1]
          .split(",")
          .map((w) => w.trim() as AgentProvider)
          .filter((w) => VALID_PROVIDERS.includes(w));
        continue;
      }

      // Accumulate description
      descLines.push(line);
    }
  }

  flushTask();
  description = descLines.join("\n").trim();

  if (tasks.length === 0) {
    throw new Error("No tasks found in plan. Use '## Task N: Title [priority]' headings.");
  }

  if (workers.length === 0) {
    workers = ["claude-code"];
  }

  return { description, workers, tasks };
}

/**
 * Serialize a plan back to markdown format.
 */
export function planToMarkdown(
  title: string,
  plan: ParsedPlan
): string {
  const lines: string[] = [];

  lines.push(`# ${title}`, "");
  if (plan.description) {
    lines.push(plan.description, "");
  }
  lines.push(`Workers: ${plan.workers.join(", ")}`, "");

  plan.tasks.forEach((task, i) => {
    const priority = task.priority || "normal";
    lines.push(`## Task ${i + 1}: ${task.title} [${priority}]`);
    lines.push(task.description);
    if (task.files && task.files.length > 0) {
      lines.push(`Files: ${task.files.join(", ")}`);
    }
    if (task.dependsOnIndex && task.dependsOnIndex.length > 0) {
      lines.push(`Depends on: ${task.dependsOnIndex.map((d) => d + 1).join(", ")}`);
    }
    lines.push("");
  });

  return lines.join("\n");
}
