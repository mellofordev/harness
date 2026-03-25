/**
 * Claude Code Agent Adapter
 *
 * Bridges Harness tasks to Claude Code's CLI (`claude`).
 *
 * Invocation modes supported:
 *   1. Print mode (-p):  claude -p "<prompt>"
 *      Non-interactive, outputs result to stdout. Best for automated tasks.
 *
 *   2. Continue mode (-c): claude -c "<prompt>"
 *      Resumes the most recent session. Useful for follow-up tasks that
 *      need memory of prior work in the same directory.
 *
 *   3. Resume mode (--resume <sessionId>): claude --resume <id>
 *      Resumes a specific named session. Used when a handoff specifies
 *      an exact Claude session to continue from.
 *
 * Prompt design:
 *   Claude Code understands markdown well, so we use rich structured
 *   prompts with headers, code blocks, and explicit task boundaries.
 *   We also inject a <harness> XML tag block so Claude Code knows it's
 *   operating inside a multi-agent orchestration context.
 */

import { execSync } from "node:child_process";
import { BaseAgentAdapter } from "./base";
import type { TaskContext } from "./base";
import type { Task, TaskResult } from "../core/types";
import { logger } from "../utils/logger";

export type ClaudeCodeMode = "print" | "continue" | "resume";

export interface ClaudeCodeOptions {
  mode?: ClaudeCodeMode;
  resumeSessionId?: string;
  model?: string;           // e.g. "claude-opus-4-5", "claude-sonnet-4-5"
  maxTurns?: number;
  allowedTools?: string[];  // e.g. ["Read", "Write", "Bash"]
  timeoutMs?: number;
  maxOutputBytes?: number;
  dryRun?: boolean;
}

export class ClaudeCodeAdapter extends BaseAgentAdapter {
  readonly provider = "claude-code" as const;
  readonly displayName = "Claude Code";
  readonly capabilities = [
    "code-generation",
    "code-review",
    "debugging",
    "refactoring",
    "testing",
    "documentation",
    "multi-file-edit",
    "bash-execution",
    "planning",
  ];

  private cliOptions: ClaudeCodeOptions;

  constructor(options: ClaudeCodeOptions = {}) {
    super({ timeoutMs: options.timeoutMs, maxOutputBytes: options.maxOutputBytes, dryRun: options.dryRun });
    this.cliOptions = {
      mode: "print",
      model: "claude-sonnet-4-5",
      maxTurns: 10,
      ...options,
    };
  }

  async isAvailable(): Promise<boolean> {
    try {
      execSync("claude --version", { stdio: "pipe", timeout: 5000 });
      return true;
    } catch {
      return false;
    }
  }

  async execute(task: Task, context: TaskContext): Promise<TaskResult> {
    const prompt = this.buildPrompt(task, context);

    if (this.options.dryRun) {
      logger.agent("claude-code", `[DRY RUN] Would execute: ${task.title}`);
      return {
        success: true,
        summary: `[DRY RUN] Claude Code would process: ${task.title}`,
        filesChanged: [],
        output: prompt.slice(0, 500),
      };
    }

    logger.agent("claude-code", `Executing: ${task.title}`, task.id);

    try {
      const cmd = this.buildCommand(prompt);
      logger.debug(`Claude Code command: ${cmd.slice(0, 120)}...`);

      const output = execSync(cmd, {
        encoding: "utf-8",
        timeout: this.options.timeoutMs,
        cwd: context.workDir,
        maxBuffer: this.options.maxOutputBytes,
        env: { ...process.env },
      });

      const truncated = this.truncateOutput(output);
      const filesChanged = this.extractChangedFiles(output, task.files);

      return {
        success: true,
        summary: this.extractSummary(output, task.title),
        filesChanged,
        output: truncated,
      };
    } catch (err: unknown) {
      const error = err instanceof Error ? err : new Error(String(err));
      const stderr = (error as NodeJS.ErrnoException & { stderr?: string }).stderr || "";
      const stdout = (error as NodeJS.ErrnoException & { stdout?: string }).stdout || "";

      // Claude Code can exit non-zero but still produce useful output
      if (stdout && stdout.length > 100) {
        logger.warn("Claude Code exited non-zero but produced output — treating as partial success");
        return {
          success: false,
          summary: `Partial completion: ${task.title}`,
          filesChanged: this.extractChangedFiles(stdout, task.files),
          output: this.truncateOutput(stdout),
          errors: [stderr.slice(0, 500)],
        };
      }

      throw new Error(`Claude Code failed: ${stderr || error.message}`);
    }
  }

  /**
   * Claude Code-specific prompt with harness context block and structured
   * instructions that match Claude's markdown reasoning style.
   */
  buildPrompt(task: Task, context: TaskContext): string {
    const base = super.buildPrompt(task, context);

    // Prepend the harness context block so Claude knows it's part of a pipeline
    const harnessBlock = this.buildHarnessContextBlock(context);

    // Append Claude-specific output format instructions
    const outputInstructions = [
      "",
      "## Output format:",
      "When done, end your response with a summary section:",
      "```",
      "HARNESS_RESULT:",
      "  summary: <one sentence describing what you did>",
      "  files_changed: <comma-separated list of files actually modified>",
      "  status: success | partial | failed",
      "```",
    ].join("\n");

    return `${harnessBlock}\n\n${base}${outputInstructions}`;
  }

  // ─── Private Helpers ─────────────────────────────────────────

  private buildCommand(prompt: string): string {
    const escaped = prompt.replace(/'/g, `'\\''`); // safe single-quote escaping
    const parts = ["claude"];

    switch (this.cliOptions.mode) {
      case "continue":
        parts.push("-c");
        break;
      case "resume":
        if (this.cliOptions.resumeSessionId) {
          parts.push("--resume", this.cliOptions.resumeSessionId);
        } else {
          parts.push("-p"); // Fallback to print if no session ID
        }
        break;
      case "print":
      default:
        parts.push("-p");
    }

    if (this.cliOptions.model) {
      parts.push("--model", this.cliOptions.model);
    }

    if (this.cliOptions.maxTurns) {
      parts.push("--max-turns", String(this.cliOptions.maxTurns));
    }

    if (this.cliOptions.allowedTools && this.cliOptions.allowedTools.length > 0) {
      parts.push("--allowedTools", this.cliOptions.allowedTools.join(","));
    }

    parts.push(`'${escaped}'`);
    return parts.join(" ");
  }

  private buildHarnessContextBlock(context: TaskContext): string {
    const lines = [
      "<harness>",
      "  You are a worker agent in a Harness multi-agent orchestration session.",
      `  Working directory: ${context.workDir}`,
      context.planTitle ? `  Current plan: ${context.planTitle}` : "",
      "  Instructions: Complete only the task described below. Report your",
      "  results using the HARNESS_RESULT format at the end of your response.",
    ];

    if (context.scratchpadPath) {
      lines.push(`  Scratchpad: ${context.scratchpadPath} — update this file with your progress and findings.`);
    }

    lines.push("</harness>");

    return lines.filter(Boolean).join("\n");
  }

  private extractSummary(output: string, fallbackTitle: string): string {
    // Parse the HARNESS_RESULT block if present
    const match = output.match(/HARNESS_RESULT:[\s\S]*?summary:\s*(.+)/);
    if (match) return match[1].trim();

    // Fallback: use the first non-empty line of output
    const firstLine = output.split("\n").find((l) => l.trim().length > 20);
    return firstLine?.trim() ?? `Claude Code completed: ${fallbackTitle}`;
  }

  private extractChangedFiles(output: string, taskFiles: string[]): string[] {
    // Parse from HARNESS_RESULT if present
    const match = output.match(/HARNESS_RESULT:[\s\S]*?files_changed:\s*(.+)/);
    if (match) {
      return match[1]
        .split(",")
        .map((f) => f.trim())
        .filter(Boolean);
    }

    // Fallback: return the files declared in the task
    return taskFiles;
  }
}
