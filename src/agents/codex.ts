/**
 * OpenAI Codex CLI Adapter
 *
 * Bridges Harness tasks to OpenAI's open-source Codex CLI tool.
 * https://github.com/openai/codex
 *
 * Codex CLI invocation:
 *   codex "<prompt>"                        Interactive mode (requires terminal)
 *   codex -q "<prompt>"                     Quiet mode, minimal output
 *   codex --approval-mode full-auto "<p>"   Full autonomous mode (no confirmations)
 *   codex --model o4-mini "<prompt>"        Specify model
 *
 * Key differences from Claude Code:
 *   - Codex is more cautious by default (asks for confirmation on file edits)
 *   - Use --approval-mode full-auto for unattended operation
 *   - Codex has built-in sandboxing via seatbelt/Landlock on macOS/Linux
 *   - Outputs are less structured — we parse them heuristically
 *   - Supports OpenAI model selection (gpt-4o, o4-mini, o3, etc.)
 *
 * Prompt design for Codex:
 *   Codex responds well to direct, imperative instructions. It uses
 *   the project context from the working directory automatically.
 *   We keep prompts shorter and more direct than for Claude Code.
 */

import { execSync } from "node:child_process";
import { BaseAgentAdapter } from "./base";
import type { TaskContext } from "./base";
import type { Task, TaskResult } from "../core/types";
import { logger } from "../utils/logger";

export type CodexApprovalMode = "suggest" | "auto-edit" | "full-auto";

export interface CodexAdapterOptions {
  model?: string;           // e.g. "o4-mini", "gpt-4o", "o3"
  approvalMode?: CodexApprovalMode;
  quiet?: boolean;
  provider?: string;        // Codex supports multiple backends (openai, azure, etc.)
  timeoutMs?: number;
  maxOutputBytes?: number;
  dryRun?: boolean;
}

export class CodexAdapter extends BaseAgentAdapter {
  readonly provider = "codex" as const;
  readonly displayName = "OpenAI Codex CLI";
  readonly capabilities = [
    "code-generation",
    "code-review",
    "debugging",
    "refactoring",
    "bash-execution",
    "multi-file-edit",
  ];

  private cliOptions: Required<CodexAdapterOptions>;

  constructor(options: CodexAdapterOptions = {}) {
    super({ timeoutMs: options.timeoutMs, maxOutputBytes: options.maxOutputBytes, dryRun: options.dryRun });
    this.cliOptions = {
      model: "o4-mini",
      approvalMode: "full-auto",  // Needed for unattended operation
      quiet: true,
      provider: "openai",
      timeoutMs: options.timeoutMs ?? 300_000,
      maxOutputBytes: options.maxOutputBytes ?? 10 * 1024 * 1024,
      dryRun: options.dryRun ?? false,
      ...options,
    };
  }

  async isAvailable(): Promise<boolean> {
    try {
      execSync("codex --version", { stdio: "pipe", timeout: 5000 });
      return true;
    } catch {
      return false;
    }
  }

  async execute(task: Task, context: TaskContext): Promise<TaskResult> {
    if (this.options.dryRun) {
      logger.agent("codex", `[DRY RUN] Would execute: ${task.title}`);
      return {
        success: true,
        summary: `[DRY RUN] Codex would process: ${task.title}`,
        filesChanged: [],
        output: this.buildPrompt(task, context).slice(0, 500),
      };
    }

    logger.agent("codex", `Executing: ${task.title}`, task.id);

    try {
      const prompt = this.buildPrompt(task, context);
      const cmd = this.buildCommand(prompt);
      logger.debug(`Codex command: ${cmd.slice(0, 120)}...`);

      const output = execSync(cmd, {
        encoding: "utf-8",
        timeout: this.options.timeoutMs,
        cwd: context.workDir,
        maxBuffer: this.options.maxOutputBytes,
        env: {
          ...process.env,
          // Disable interactive prompts in CI/automated context
          CI: "true",
          TERM: "dumb",
        },
      });

      const truncated = this.truncateOutput(output);

      return {
        success: true,
        summary: this.extractSummary(output, task.title),
        filesChanged: this.extractChangedFiles(output, task.files),
        output: truncated,
      };
    } catch (err: unknown) {
      const error = err instanceof Error ? err : new Error(String(err));
      const stdout = (error as NodeJS.ErrnoException & { stdout?: string }).stdout || "";
      const stderr = (error as NodeJS.ErrnoException & { stderr?: string }).stderr || "";

      // Codex may fail but still have done useful work
      if (stdout.length > 50) {
        logger.warn("Codex exited non-zero but produced output");
        return {
          success: false,
          summary: `Partial: ${task.title}`,
          filesChanged: this.extractChangedFiles(stdout, task.files),
          output: this.truncateOutput(stdout),
          errors: [stderr.slice(0, 500)],
        };
      }

      throw new Error(`Codex failed: ${stderr || error.message}`);
    }
  }

  /**
   * Codex prompt: concise, imperative, no XML blocks.
   * Codex reads the project directory itself, so we don't need to
   * explain the codebase — just the specific task.
   */
  buildPrompt(task: Task, context: TaskContext): string {
    const lines: string[] = [task.title, "", task.description];

    if (task.files.length > 0) {
      lines.push("", `Focus on these files: ${task.files.join(", ")}`);
    }

    const depEntries = Object.entries(context.dependencyResults);
    if (depEntries.length > 0) {
      lines.push("", "Note: The following work has already been completed:");
      for (const [, result] of depEntries) {
        lines.push(`  - ${result.summary}`);
      }
    }

    lines.push(
      "",
      "Important: Only modify the files relevant to this task.",
      "Make minimal, focused changes."
    );

    return lines.join("\n");
  }

  // ─── Private Helpers ─────────────────────────────────────────

  private buildCommand(prompt: string): string {
    const escaped = prompt.replace(/'/g, `'\\''`);
    const parts = ["codex"];

    if (this.cliOptions.quiet) {
      parts.push("-q");
    }

    if (this.cliOptions.approvalMode) {
      parts.push("--approval-mode", this.cliOptions.approvalMode);
    }

    if (this.cliOptions.model) {
      parts.push("--model", this.cliOptions.model);
    }

    parts.push(`'${escaped}'`);
    return parts.join(" ");
  }

  private extractSummary(output: string, fallbackTitle: string): string {
    // Codex doesn't have a structured output format — heuristically find a summary line
    const lines = output.split("\n").filter((l) => l.trim().length > 20);

    // Look for lines that sound like a summary
    const summaryLine = lines.find(
      (l) =>
        l.match(/completed|finished|done|created|updated|added|removed|fixed/i) &&
        l.length < 200
    );

    return summaryLine?.trim() ?? `Codex completed: ${fallbackTitle}`;
  }

  private extractChangedFiles(output: string, taskFiles: string[]): string[] {
    const changed: string[] = [];

    // Codex outputs often include lines like "Editing src/foo.ts" or "Writing src/bar.ts"
    const patterns = [
      /(?:editing|writing|creating|updating|modifying)\s+([^\s]+\.\w+)/gi,
      /\+\+\+\s+b\/([^\s]+)/g,  // Unified diff format
    ];

    for (const pattern of patterns) {
      const matches = [...output.matchAll(pattern)];
      for (const match of matches) {
        if (match[1]) changed.push(match[1]);
      }
    }

    // Deduplicate and fall back to task files if nothing found
    const unique = [...new Set(changed)];
    return unique.length > 0 ? unique : taskFiles;
  }
}
