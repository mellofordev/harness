/**
 * Auto-Spawn Module
 *
 * Discovers available AI CLIs on the machine and spawns workers
 * automatically. No manual `harness spawn <provider>` needed.
 *
 * Selection priority for lead (decomposer) agent:
 *   claude-code > codex > gemini-cli
 */

import type { AgentProvider, HarnessConfig } from "./types";
import type { Orchestrator } from "./orchestrator";
import { REGISTRY } from "../agents/index";
import { getAdapterConfig } from "./config";
import { logger } from "../utils/logger";

export interface AutoSpawnResult {
  spawned: AgentProvider[];
  unavailable: AgentProvider[];
  lead: AgentProvider;
}

const LEAD_PREFERENCE: AgentProvider[] = ["claude-code", "codex", "gemini-cli"];

export async function autoSpawn(
  orchestrator: Orchestrator,
  config: HarnessConfig,
  options?: { dryRun?: boolean }
): Promise<AutoSpawnResult> {
  const availability = await REGISTRY.checkAll();
  const adapterConfig = getAdapterConfig(config.workDir);

  const spawned: AgentProvider[] = [];
  const unavailable: AgentProvider[] = [];

  for (const [provider, available] of Object.entries(availability)) {
    if (!available) {
      unavailable.push(provider as AgentProvider);
      continue;
    }

    const providerConfig = config.providers[provider as AgentProvider];
    if (providerConfig && !providerConfig.enabled) {
      logger.debug(`Skipping disabled provider: ${provider}`);
      continue;
    }

    const adapterOptions: Record<string, unknown> = {
      ...(adapterConfig?.[provider as keyof typeof adapterConfig] || {}),
      dryRun: options?.dryRun ?? false,
    };

    try {
      orchestrator.spawnWorker(provider as AgentProvider, config.workDir, adapterOptions);
      spawned.push(provider as AgentProvider);
      logger.info(`Auto-spawned worker: ${provider}`);
    } catch (err) {
      logger.warn(`Failed to spawn ${provider}: ${err instanceof Error ? err.message : err}`);
      unavailable.push(provider as AgentProvider);
    }
  }

  if (spawned.length === 0) {
    throw new Error(
      "No AI CLI tools available. Install at least one:\n" +
      "  Claude Code: https://claude.ai/code\n" +
      "  Codex:       npm install -g @openai/codex\n" +
      "  Gemini CLI:  https://github.com/google-gemini/gemini-cli"
    );
  }

  // Select lead provider
  let lead: AgentProvider;
  if (config.leadProvider && spawned.includes(config.leadProvider)) {
    lead = config.leadProvider;
  } else {
    lead = LEAD_PREFERENCE.find((p) => spawned.includes(p)) || spawned[0];
  }

  logger.info(`Lead agent for decomposition: ${lead}`);

  return { spawned, unavailable, lead };
}
