/**
 * Smart Commit Hook
 *
 * Generates meaningful git commit messages using AI, inspired by entire.io's
 * checkpointing approach. Provides full context about what was built and why.
 *
 * Commit format:
 *   type(scope): subject
 *
 *   body — what was done, which tasks completed, files changed
 *
 *   Harness-Plan: <plan title>
 *   Harness-Tasks: <completed task count>/<total task count>
 */

import { execSync } from "node:child_process";
import type { AgentProvider, TaskResult } from "../core/types";
import { logger } from "../utils/logger";

export interface CommitOptions {
  workDir: string;
  planTitle: string;
  planDescription: string;
  taskResults: TaskResult[];
  provider: AgentProvider;
}

// ─── Git Helpers ────────────────────────────────────────────────

function gitDiffStat(workDir: string): string {
  try {
    return execSync("git diff --stat HEAD", {
      encoding: "utf-8",
      cwd: workDir,
      timeout: 10_000,
    }).trim();
  } catch {
    return "";
  }
}

function gitHasChanges(workDir: string): boolean {
  try {
    const status = execSync("git status --porcelain", {
      encoding: "utf-8",
      cwd: workDir,
      timeout: 10_000,
    }).trim();
    return status.length > 0;
  } catch {
    return false;
  }
}

function gitStageAll(workDir: string): void {
  execSync("git add -A", { cwd: workDir, timeout: 10_000 });
}

function gitCommit(workDir: string, message: string): string {
  const escaped = message.replace(/'/g, "'\\''");
  const output = execSync(`git commit -m '${escaped}'`, {
    encoding: "utf-8",
    cwd: workDir,
    timeout: 30_000,
  });
  // Extract commit hash from output like "[main abc1234] message"
  const match = output.match(/\[[\w/.-]+ ([a-f0-9]+)\]/);
  return match?.[1] || "unknown";
}

// ─── Commit Message Generation ──────────────────────────────────

const COMMIT_PROMPT = (opts: {
  planTitle: string;
  planDescription: string;
  diffStat: string;
  taskSummaries: string;
}) => `You are writing a git commit message for changes made by an AI orchestration system.

Plan: ${opts.planTitle}
Description: ${opts.planDescription}

Files changed:
${opts.diffStat}

Task summaries:
${opts.taskSummaries}

Write a conventional commit message following this format:
type(scope): subject (max 72 chars)

body (wrap at 72 chars, explain what was done and why)

Harness-Plan: ${opts.planTitle}

Rules:
- type: feat, fix, refactor, test, docs, chore, perf, style
- scope: the main area of change (e.g., auth, api, config)
- subject: imperative mood, no period, lowercase
- body: summarize the key changes and their purpose
- Output ONLY the commit message text, nothing else`;

function buildCommitCommand(provider: AgentProvider, prompt: string): string {
  const escaped = prompt.replace(/'/g, "'\\''");
  switch (provider) {
    case "claude-code":
      return `claude -p '${escaped}' --max-turns 1`;
    case "codex":
      return `codex -q --approval-mode suggest '${escaped}'`;
    default:
      return `claude -p '${escaped}' --max-turns 1`;
  }
}

async function generateCommitMessage(
  options: CommitOptions,
  diffStat: string
): Promise<string> {
  const taskSummaries = options.taskResults
    .map((r, i) => `${i + 1}. [${r.success ? "done" : "failed"}] ${r.summary}`)
    .join("\n");

  const prompt = COMMIT_PROMPT({
    planTitle: options.planTitle,
    planDescription: options.planDescription,
    diffStat,
    taskSummaries,
  });

  try {
    const cmd = buildCommitCommand(options.provider, prompt);
    const output = execSync(cmd, {
      encoding: "utf-8",
      timeout: 60_000,
      cwd: options.workDir,
      maxBuffer: 5 * 1024 * 1024,
      env: { ...process.env },
    });

    // Clean up the response — strip markdown fences if present
    let message = output.trim();
    message = message.replace(/^```\w*\n?/, "").replace(/\n?```$/, "").trim();

    if (message.length > 0) return message;
  } catch (err) {
    logger.warn(`AI commit message generation failed: ${err instanceof Error ? err.message : err}`);
  }

  // Fallback: generate a simple message
  const filesChanged = options.taskResults.flatMap((r) => r.filesChanged);
  const taskCount = options.taskResults.length;
  const successCount = options.taskResults.filter((r) => r.success).length;

  return (
    `feat: ${options.planTitle.toLowerCase().slice(0, 60)}\n\n` +
    `Completed ${successCount}/${taskCount} tasks via Harness orchestration.\n` +
    `Files changed: ${filesChanged.length}\n\n` +
    `Harness-Plan: ${options.planTitle}`
  );
}

// ─── Public API ─────────────────────────────────────────────────

export async function smartCommit(options: CommitOptions): Promise<string | null> {
  if (!gitHasChanges(options.workDir)) {
    logger.info("No changes to commit");
    return null;
  }

  const diffStat = gitDiffStat(options.workDir);

  logger.info("Generating commit message...");

  const message = await generateCommitMessage(options, diffStat);

  logger.info("Staging all changes...");
  gitStageAll(options.workDir);

  logger.info("Committing...");
  const hash = gitCommit(options.workDir, message);

  logger.info(`Committed: ${hash}`);
  return hash;
}
