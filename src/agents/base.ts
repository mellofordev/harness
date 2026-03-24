/**
 * Base Agent Adapter
 *
 * Every provider (Claude Code, Cursor, Codex, etc.) implements this interface.
 * The Worker class only knows about this interface — it never imports a provider directly.
 *
 * Each adapter is responsible for:
 *   - Building prompts that the provider understands
 *   - Spawning / calling the CLI tool
 *   - Parsing the output back into a TaskResult
 *   - Advertising what it can and can't do (capabilities)
 */

import type { Task, TaskResult, AgentProvider } from "../core/types";

// ─── Adapter Interface ──────────────────────────────────────────

export interface AgentAdapter {
  /** The provider this adapter handles */
  readonly provider: AgentProvider;

  /** Human-readable display name */
  readonly displayName: string;

  /** What this agent can do — used by the planner for smart assignment */
  readonly capabilities: string[];

  /**
   * Check whether the underlying CLI tool is present on PATH.
   * Called during discovery to report availability.
   */
  isAvailable(): Promise<boolean>;

  /**
   * Execute a single task and return the result.
   * The adapter owns prompt construction, execution, and output parsing.
   */
  execute(task: Task, context: TaskContext): Promise<TaskResult>;

  /**
   * Build the prompt string for a given task.
   * Exposed separately so the planner can preview prompts during planning.
   */
  buildPrompt(task: Task, context: TaskContext): string;
}

// ─── Execution Context ──────────────────────────────────────────

export interface TaskContext {
  /** The directory the agent should work in */
  workDir: string;

  /** Results from completed dependency tasks, keyed by task ID */
  dependencyResults: Record<string, TaskResult>;

  /** The overall plan title and description */
  planTitle?: string;
  planDescription?: string;

  /** Any handoff context from a previous agent */
  handoffContext?: Record<string, unknown>;
}

// ─── Execution Options (shared across adapters) ─────────────────

export interface ExecutionOptions {
  timeoutMs: number;
  maxOutputBytes: number;
  dryRun: boolean;
}

export const DEFAULT_EXECUTION_OPTIONS: ExecutionOptions = {
  timeoutMs: 300_000,   // 5 minutes
  maxOutputBytes: 10 * 1024 * 1024, // 10 MB
  dryRun: false,
};

// ─── Abstract Base (optional convenience class) ─────────────────

/**
 * Provides shared prompt-building logic so adapters only need to
 * override the parts specific to their provider.
 */
export abstract class BaseAgentAdapter implements AgentAdapter {
  abstract readonly provider: AgentProvider;
  abstract readonly displayName: string;
  abstract readonly capabilities: string[];

  protected options: ExecutionOptions;

  constructor(options?: Partial<ExecutionOptions>) {
    this.options = { ...DEFAULT_EXECUTION_OPTIONS, ...options };
  }

  abstract isAvailable(): Promise<boolean>;
  abstract execute(task: Task, context: TaskContext): Promise<TaskResult>;

  /**
   * Default prompt template. Adapters can override this entirely
   * or call super.buildPrompt() and append provider-specific sections.
   */
  buildPrompt(task: Task, context: TaskContext): string {
    const lines: string[] = [];

    // Header
    lines.push(`# ${task.title}`);
    lines.push("");
    lines.push(task.description);

    // Files in scope
    if (task.files.length > 0) {
      lines.push("");
      lines.push("## Files to work on:");
      for (const file of task.files) {
        lines.push(`  - ${file}`);
      }
    }

    // Context from dependency tasks
    const depEntries = Object.entries(context.dependencyResults);
    if (depEntries.length > 0) {
      lines.push("");
      lines.push("## Context from completed tasks:");
      for (const [, result] of depEntries) {
        lines.push(`  - ${result.summary}`);
        if (result.filesChanged.length > 0) {
          lines.push(`    Changed: ${result.filesChanged.join(", ")}`);
        }
      }
    }

    // Plan context
    if (context.planTitle) {
      lines.push("");
      lines.push(`## Overall goal: ${context.planTitle}`);
      if (context.planDescription) {
        lines.push(context.planDescription);
      }
    }

    // Constraints
    lines.push("");
    lines.push("## Constraints:");
    lines.push("  - Focus only on this specific task");
    lines.push("  - Only modify files listed above (or directly related files)");
    lines.push("  - Report any blockers or ambiguities clearly");

    return lines.join("\n");
  }

  /** Truncate output to stay within limits */
  protected truncateOutput(output: string): string {
    if (output.length <= this.options.maxOutputBytes) return output;
    const truncated = output.slice(0, this.options.maxOutputBytes);
    return truncated + `\n\n[Output truncated at ${this.options.maxOutputBytes} bytes]`;
  }

  /** Parse exit-code-based success */
  protected parseSuccess(exitCode: number, stderr: string): boolean {
    return exitCode === 0 && !stderr.toLowerCase().includes("fatal error");
  }
}
