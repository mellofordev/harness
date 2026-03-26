/**
 * AI Task Decomposer
 *
 * Uses an available AI CLI (preferring claude-code) to decompose a
 * high-level user prompt into structured TaskDefinitions. This replaces
 * the need for users to manually write plan files.
 *
 * The decomposer sends a meta-prompt to the AI asking it to:
 *   1. Analyze the user's request in context of the project
 *   2. Break it into 2-8 discrete, parallelizable tasks
 *   3. Return structured JSON with titles, descriptions, priorities,
 *      file targets, and dependency ordering
 */

import { execSync } from "node:child_process";
import type { AgentProvider } from "../core/types";
import type { TaskDefinition } from "./planner";
import { logger } from "../utils/logger";

export interface DecomposeOptions {
  provider: AgentProvider;
  workDir: string;
  mode: "normal" | "plan";
  model?: string;
}

export interface DecomposeResult {
  title: string;
  description: string;
  tasks: TaskDefinition[];
  reasoning?: string;
}

// ─── Meta-Prompt Templates ──────────────────────────────────────

const DECOMPOSE_PROMPT = (prompt: string, mode: "normal" | "plan") => `You are a technical project planner inside a multi-agent orchestration system called Harness.

Given the user's request below, decompose it into discrete implementation tasks that can be assigned to independent AI coding agents.

<user_request>
${prompt}
</user_request>

Instructions:
- First, read the project structure to understand the codebase
- Break the request into 2-8 tasks that can be assigned to independent workers
- Each task should be completable in isolation (workers receive dependency results as context)
- Identify file targets and parallelization opportunities
- Tasks with no dependencies can run in parallel
- Use dependsOnIndex to create a DAG (directed acyclic graph) of task execution order
${mode === "plan" ? "- Provide detailed reasoning for your decomposition choices\n- Be thorough — the user will review this plan before execution" : "- Be concise — this plan will execute immediately"}

You MUST output ONLY a single JSON block in this exact format (no markdown fences, no explanation outside the JSON):

{
  "title": "short plan title (under 60 chars)",
  "description": "one-paragraph summary of the overall plan",
  ${mode === "plan" ? '"reasoning": "explanation of why you decomposed the task this way",' : ""}
  "tasks": [
    {
      "title": "task title",
      "description": "detailed instructions for the AI agent executing this task",
      "priority": "high",
      "files": ["src/path/to/relevant/file.ts"],
      "dependsOnIndex": []
    }
  ]
}

Priority values: "critical", "high", "normal", "low"
dependsOnIndex: array of 0-based task indices this task depends on (empty = can start immediately)`;

// ─── CLI Command Builders ───────────────────────────────────────

function buildClaudeCommand(prompt: string, model?: string): string {
  const escaped = prompt.replace(/'/g, "'\\''");
  const parts = ["claude", "-p", `'${escaped}'`, "--max-turns", "3"];
  if (model) parts.push("--model", model);
  return parts.join(" ");
}

function buildCodexCommand(prompt: string, model?: string): string {
  const escaped = prompt.replace(/'/g, "'\\''");
  const parts = ["codex", "-q", "--approval-mode", "suggest", `'${escaped}'`];
  if (model) parts.push("--model", model);
  return parts.join(" ");
}

function buildCommand(provider: AgentProvider, prompt: string, model?: string): string {
  switch (provider) {
    case "claude-code":
      return buildClaudeCommand(prompt, model);
    case "codex":
      return buildCodexCommand(prompt, model);
    default:
      // Fallback to claude-code style
      return buildClaudeCommand(prompt, model);
  }
}

// ─── JSON Extraction ────────────────────────────────────────────

function extractJson(output: string): unknown | null {
  // Try to find a JSON block — could be bare or in markdown fences
  const fencedMatch = output.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  if (fencedMatch) {
    try {
      return JSON.parse(fencedMatch[1].trim());
    } catch { /* fall through */ }
  }

  // Try to find bare JSON object
  const braceMatch = output.match(/\{[\s\S]*\}/);
  if (braceMatch) {
    try {
      return JSON.parse(braceMatch[0]);
    } catch { /* fall through */ }
  }

  return null;
}

function validateDecomposeResult(data: unknown): DecomposeResult | null {
  if (!data || typeof data !== "object") return null;
  const obj = data as Record<string, unknown>;

  if (typeof obj.title !== "string" || !obj.title) return null;
  if (!Array.isArray(obj.tasks) || obj.tasks.length === 0) return null;

  const tasks: TaskDefinition[] = [];
  for (const raw of obj.tasks) {
    if (!raw || typeof raw !== "object") return null;
    const t = raw as Record<string, unknown>;
    if (typeof t.title !== "string" || !t.title) return null;

    tasks.push({
      title: t.title,
      description: typeof t.description === "string" ? t.description : t.title,
      priority: ["critical", "high", "normal", "low"].includes(t.priority as string)
        ? (t.priority as TaskDefinition["priority"])
        : "normal",
      files: Array.isArray(t.files) ? t.files.filter((f): f is string => typeof f === "string") : undefined,
      dependsOnIndex: Array.isArray(t.dependsOnIndex)
        ? t.dependsOnIndex.filter((n): n is number => typeof n === "number" && n >= 0)
        : undefined,
    });
  }

  return {
    title: obj.title as string,
    description: typeof obj.description === "string" ? obj.description : (obj.title as string),
    tasks,
    reasoning: typeof obj.reasoning === "string" ? obj.reasoning : undefined,
  };
}

// ─── Public API ─────────────────────────────────────────────────

export async function decomposePrompt(
  prompt: string,
  options: DecomposeOptions
): Promise<DecomposeResult> {
  const { provider, workDir, mode, model } = options;

  const metaPrompt = DECOMPOSE_PROMPT(prompt, mode);
  const cmd = buildCommand(provider, metaPrompt, model);

  logger.info(`Decomposing prompt via ${provider}...`);
  logger.debug(`Command: ${cmd.slice(0, 120)}...`);

  try {
    const output = execSync(cmd, {
      encoding: "utf-8",
      timeout: 120_000, // 2 min timeout for decomposition
      cwd: workDir,
      maxBuffer: 10 * 1024 * 1024,
      env: { ...process.env },
    });

    const parsed = extractJson(output);
    const result = validateDecomposeResult(parsed);

    if (result) {
      logger.info(`Decomposed into ${result.tasks.length} tasks: "${result.title}"`);
      return result;
    }

    logger.warn("Could not parse AI decomposition output — using single-task fallback");
    logger.debug(`Raw output (first 500 chars): ${output.slice(0, 500)}`);
    return createFallback(prompt);
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    logger.warn(`AI decomposition failed: ${error.message} — using single-task fallback`);
    return createFallback(prompt);
  }
}

function createFallback(prompt: string): DecomposeResult {
  return {
    title: prompt.slice(0, 60),
    description: prompt,
    tasks: [
      {
        title: prompt.slice(0, 80),
        description: prompt,
        priority: "normal",
      },
    ],
  };
}
