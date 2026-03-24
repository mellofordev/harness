/**
 * Cursor Agent Adapter
 *
 * Bridges Harness tasks to Cursor's background agent capabilities.
 *
 * Cursor doesn't expose a traditional CLI in the same way Claude Code does,
 * so this adapter uses multiple integration strategies depending on what's
 * available:
 *
 *   Strategy A — Cursor CLI (if available):
 *     `cursor --background-agent "<prompt>"` (future Cursor CLI feature)
 *
 *   Strategy B — Workspace file injection:
 *     Write the task to a `.cursor/harness-task.md` file that the Cursor
 *     background agent is watching. Cursor's agent picks it up and processes it.
 *     Results are written back to `.cursor/harness-result.json`.
 *
 *   Strategy C — Rules-based delegation:
 *     Inject the task into `.cursorrules` or `.cursor/rules/harness.mdc` so
 *     that the next user interaction in Cursor naturally picks up the task.
 *
 * Strategy B is the default — it works without any Cursor CLI support and
 * integrates naturally with Cursor's existing workspace agent loop.
 */

import { execSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { BaseAgentAdapter } from "./base";
import type { TaskContext } from "./base";
import type { Task, TaskResult } from "../core/types";
import { logger } from "../utils/logger";

export type CursorIntegrationStrategy = "cli" | "workspace-inject" | "rules-inject";

export interface CursorAdapterOptions {
  strategy?: CursorIntegrationStrategy;
  resultPollIntervalMs?: number;
  resultTimeoutMs?: number;
  timeoutMs?: number;
  maxOutputBytes?: number;
  dryRun?: boolean;
}

const CURSOR_TASK_FILE = ".cursor/harness-task.md";
const CURSOR_RESULT_FILE = ".cursor/harness-result.json";
const CURSOR_RULES_FILE = ".cursor/rules/harness.mdc";

export class CursorAdapter extends BaseAgentAdapter {
  readonly provider = "cursor" as const;
  readonly displayName = "Cursor Background Agent";
  readonly capabilities = [
    "code-generation",
    "code-review",
    "refactoring",
    "multi-file-edit",
    "codebase-search",
  ];

  private cliOptions: Required<CursorAdapterOptions>;

  constructor(options: CursorAdapterOptions = {}) {
    super({ timeoutMs: options.timeoutMs, maxOutputBytes: options.maxOutputBytes, dryRun: options.dryRun });
    this.cliOptions = {
      strategy: "workspace-inject",
      resultPollIntervalMs: 3000,
      resultTimeoutMs: options.timeoutMs ?? 300_000,
      timeoutMs: options.timeoutMs ?? 300_000,
      maxOutputBytes: options.maxOutputBytes ?? 10 * 1024 * 1024,
      dryRun: options.dryRun ?? false,
      ...options,
    };
  }

  async isAvailable(): Promise<boolean> {
    // Check for Cursor process or CLI
    try {
      execSync("cursor --version", { stdio: "pipe", timeout: 5000 });
      return true;
    } catch {
      // Cursor doesn't have a standard CLI version flag — check if it's running
      try {
        const platform = process.platform;
        const cmd =
          platform === "win32"
            ? `tasklist | findstr /i "cursor"`
            : `ps aux | grep -i '[Cc]ursor' | grep -v grep`;
        const output = execSync(cmd, { encoding: "utf-8", timeout: 5000 });
        return output.trim().length > 0;
      } catch {
        return false;
      }
    }
  }

  async execute(task: Task, context: TaskContext): Promise<TaskResult> {
    if (this.options.dryRun) {
      logger.agent("cursor", `[DRY RUN] Would inject task: ${task.title}`);
      return {
        success: true,
        summary: `[DRY RUN] Cursor would process: ${task.title}`,
        filesChanged: [],
        output: this.buildPrompt(task, context).slice(0, 500),
      };
    }

    switch (this.cliOptions.strategy) {
      case "cli":
        return this.executeViaCli(task, context);
      case "rules-inject":
        return this.executeViaRulesInject(task, context);
      case "workspace-inject":
      default:
        return this.executeViaWorkspaceInject(task, context);
    }
  }

  /**
   * Strategy A: Use Cursor CLI directly (future capability).
   */
  private async executeViaCli(task: Task, context: TaskContext): Promise<TaskResult> {
    const prompt = this.buildPrompt(task, context);
    try {
      const output = execSync(`cursor --background-agent '${prompt.replace(/'/g, `'\\''`)}'`, {
        encoding: "utf-8",
        timeout: this.options.timeoutMs,
        cwd: context.workDir,
      });

      return {
        success: true,
        summary: `Cursor completed: ${task.title}`,
        filesChanged: task.files,
        output: this.truncateOutput(output),
      };
    } catch (err) {
      throw new Error(`Cursor CLI failed: ${err}`);
    }
  }

  /**
   * Strategy B: Write task to a watched file, poll for result.
   *
   * Requires Cursor's background agent to be watching `.cursor/harness-task.md`.
   * The agent should write its result to `.cursor/harness-result.json`.
   *
   * You can set this up in Cursor with a background agent instruction like:
   *   "Watch .cursor/harness-task.md. When it changes, complete the task
   *    described and write the result to .cursor/harness-result.json"
   */
  private async executeViaWorkspaceInject(task: Task, context: TaskContext): Promise<TaskResult> {
    const taskFilePath = join(context.workDir, CURSOR_TASK_FILE);
    const resultFilePath = join(context.workDir, CURSOR_RESULT_FILE);

    // Ensure .cursor directory exists
    const cursorDir = join(context.workDir, ".cursor");
    if (!existsSync(cursorDir)) {
      mkdirSync(cursorDir, { recursive: true });
    }

    // Write task file
    const prompt = this.buildPrompt(task, context);
    const taskPayload = {
      taskId: task.id,
      writtenAt: new Date().toISOString(),
      prompt,
    };

    logger.agent("cursor", `Injecting task into ${CURSOR_TASK_FILE}`, task.id);
    writeFileSync(taskFilePath, JSON.stringify(taskPayload, null, 2));

    // Poll for result file
    return this.pollForResult(resultFilePath, task, context.workDir);
  }

  /**
   * Strategy C: Inject task into Cursor rules file.
   * The task becomes a standing instruction Cursor's agent will follow.
   */
  private async executeViaRulesInject(task: Task, context: TaskContext): Promise<TaskResult> {
    const rulesDir = join(context.workDir, ".cursor", "rules");
    if (!existsSync(rulesDir)) {
      mkdirSync(rulesDir, { recursive: true });
    }

    const rulesFilePath = join(context.workDir, CURSOR_RULES_FILE);
    const prompt = this.buildPrompt(task, context);

    const rulesContent = [
      "---",
      "description: Harness orchestration task (auto-generated, do not edit manually)",
      "alwaysApply: true",
      "---",
      "",
      "# Active Harness Task",
      "",
      prompt,
      "",
      "When you complete this task, write the result to `.cursor/harness-result.json`",
      "with the shape: `{ taskId, summary, filesChanged, success }`.",
    ].join("\n");

    logger.agent("cursor", `Injecting task into ${CURSOR_RULES_FILE}`, task.id);
    writeFileSync(rulesFilePath, rulesContent);

    const resultFilePath = join(context.workDir, CURSOR_RESULT_FILE);
    return this.pollForResult(resultFilePath, task, context.workDir);
  }

  /**
   * Poll the result file until Cursor's agent writes it, or timeout.
   */
  private pollForResult(
    resultFilePath: string,
    task: Task,
    workDir: string
  ): Promise<TaskResult> {
    return new Promise((resolve) => {
      const start = Date.now();

      const poll = setInterval(() => {
        const elapsed = Date.now() - start;

        if (elapsed > this.cliOptions.resultTimeoutMs) {
          clearInterval(poll);
          logger.warn(`Cursor task timed out after ${elapsed}ms: ${task.title}`);
          resolve({
            success: false,
            summary: `Cursor task timed out: ${task.title}`,
            filesChanged: [],
            errors: [`Timeout after ${Math.round(elapsed / 1000)}s waiting for Cursor result`],
          });
          return;
        }

        if (!existsSync(resultFilePath)) return;

        try {
          const raw = readFileSync(resultFilePath, "utf-8");
          const result = JSON.parse(raw);

          // Only accept results for this specific task
          if (result.taskId !== task.id) return;

          clearInterval(poll);
          logger.agent("cursor", `Result received for task: ${task.title}`, task.id);

          resolve({
            success: result.success ?? true,
            summary: result.summary ?? `Cursor completed: ${task.title}`,
            filesChanged: result.filesChanged ?? task.files,
            output: result.output,
            errors: result.errors,
          });
        } catch {
          // File may be partially written — retry on next tick
          // (do NOT clearInterval here — let it keep trying)
        }
      }, this.cliOptions.resultPollIntervalMs);

      // Safety net: always resolve (never reject) if something goes wrong
      // outside the poll loop. The poll itself handles timeout.
    });
  }

  /**
   * Cursor prompt is more concise than Claude's — Cursor agents prefer
   * direct, focused instructions over extensive markdown structure.
   */
  buildPrompt(task: Task, context: TaskContext): string {
    const lines: string[] = [
      `**Task:** ${task.title}`,
      "",
      task.description,
    ];

    if (task.files.length > 0) {
      lines.push("", `**Files:** ${task.files.join(", ")}`);
    }

    const depEntries = Object.entries(context.dependencyResults);
    if (depEntries.length > 0) {
      lines.push("", "**Prior work:**");
      for (const [, result] of depEntries) {
        lines.push(`  - ${result.summary}`);
      }
    }

    lines.push(
      "",
      "**When done:** Write results to `.cursor/harness-result.json` with:",
      "```json",
      `{ "taskId": "${task.id}", "success": true, "summary": "...", "filesChanged": [] }`,
      "```"
    );

    return lines.join("\n");
  }
}
