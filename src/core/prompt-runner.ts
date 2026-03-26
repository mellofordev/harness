import { join, resolve } from "node:path";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { Orchestrator } from "./orchestrator";
import type { AgentProvider, HarnessConfig } from "./types";
import type { PlanStatus, TaskDefinition } from "../planner/planner";
import { autoSpawn } from "./auto-spawn";
import { decomposePrompt } from "../planner/ai-decomposer";
import { REGISTRY } from "../agents";
import { getAdapterConfig } from "./config";

export interface PreparedPromptRun {
  prompt: string;
  mode: "normal" | "plan";
  title: string;
  description: string;
  tasks: TaskDefinition[];
  leadProvider: AgentProvider;
  workerProviders: AgentProvider[];
}

export interface PromptRunSummary {
  success: boolean;
  title: string;
  description: string;
  mode: "normal" | "plan";
  leadProvider: AgentProvider;
  workerProviders: AgentProvider[];
  status: PlanStatus;
  taskResults: Array<Record<string, unknown>>;
}

export interface ExecutePromptOptions {
  prompt: string;
  mode: "normal" | "plan";
  config: HarnessConfig;
  requestedProvider?: AgentProvider;
  preferredLeadProvider?: AgentProvider;
  workerProviders?: AgentProvider[];
  dryRun?: boolean;
  timeoutMs?: number;
  onPrepared?: (prepared: PreparedPromptRun) => void;
  onTick?: (status: PlanStatus) => void;
}

export async function executePrompt(options: ExecutePromptOptions): Promise<PromptRunSummary> {
  const {
    prompt,
    mode,
    config,
    requestedProvider,
    preferredLeadProvider,
    workerProviders: requestedWorkerProviders,
    dryRun = false,
    timeoutMs = 120_000,
    onPrepared,
    onTick,
  } = options;

  const orchestrator = new Orchestrator(config);
  await orchestrator.init(true);

  let leadProvider: AgentProvider | null = null;
  let workerProviders: AgentProvider[] = [];
  let title = prompt.slice(0, 60);
  let description = prompt;
  let tasks: TaskDefinition[] = [];

  try {
    if (requestedProvider) {
      const adapterConfig = getAdapterConfig(config.workDir);
      const adapterOptions: Record<string, unknown> = {
        ...(adapterConfig?.[requestedProvider as keyof typeof adapterConfig] || {}),
        dryRun,
      };

      if (!dryRun) {
        const available = await REGISTRY.create(requestedProvider)?.isAvailable();
        if (!available) {
          throw new Error(`'${requestedProvider}' CLI not found on PATH`);
        }
      }

      orchestrator.spawnWorker(requestedProvider, config.workDir, adapterOptions);
      workerProviders = [requestedProvider];
      leadProvider = requestedProvider;
    } else {
      const auto = await autoSpawn(orchestrator, config, {
        dryRun,
        includeProviders: requestedWorkerProviders,
        preferredLeadProvider,
      });
      workerProviders = auto.spawned;
      leadProvider = auto.lead;
    }

    if (!leadProvider) {
      throw new Error("No lead provider available for decomposition");
    }

    const decomposed = await decomposePrompt(prompt, {
      provider: leadProvider,
      workDir: config.workDir,
      mode,
      model: config.decomposerModel,
      dryRun,
    });

    title = decomposed.title;
    description = decomposed.description;
    tasks = decomposed.tasks.length > 0
      ? decomposed.tasks
      : [{ title: prompt.slice(0, 80), description: prompt, priority: "normal" }];

    onPrepared?.({
      prompt,
      mode,
      title,
      description,
      tasks,
      leadProvider,
      workerProviders,
    });

    await orchestrator.executePlan(title, description, tasks);

    const start = Date.now();
    const finalStatus = await waitForPlan(orchestrator, timeoutMs, onTick, start);
    const taskResults = readJsonDir<Record<string, unknown>>(
      join(resolve(config.workDir), config.harnessDir, "tasks")
    )
      .filter((task: any) => task?.result);

    return {
      success: finalStatus.tasks.failed === 0,
      title,
      description,
      mode,
      leadProvider,
      workerProviders,
      status: finalStatus,
      taskResults,
    };
  } finally {
    await orchestrator.shutdown();
  }
}

async function waitForPlan(
  orchestrator: Orchestrator,
  timeoutMs: number,
  onTick?: (status: PlanStatus) => void,
  start = Date.now()
) {
  return await new Promise<PlanStatus>((resolve) => {
    const interval = setInterval(() => {
      const planner = orchestrator.getPlanner();
      if (!planner) return;

      const status = planner.getStatus();
      onTick?.(status);

      if (
        status.status === "completed" ||
        planner.isPlanFailed() ||
        Date.now() - start > timeoutMs
      ) {
        clearInterval(interval);
        resolve(status);
      }
    }, 1000);
  });
}

function readJsonDir<T>(dir: string): T[] {
  if (!existsSync(dir)) return [];
  try {
    return readdirSync(dir)
      .filter((file) => file.endsWith(".json"))
      .map((file) => {
        try {
          return JSON.parse(readFileSync(join(dir, file), "utf-8")) as T;
        } catch {
          return null;
        }
      })
      .filter(Boolean) as T[];
  } catch {
    return [];
  }
}
