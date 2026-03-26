/**
 * Harness Configuration System
 *
 * Config is layered — later layers win:
 *   1. Built-in defaults
 *   2. .harness/config.json in the working directory
 *   3. CLI flags passed at runtime
 *
 * On `harness init`, a config.json is written so users can customise
 * things like model selection, timeouts, and enabled providers.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import type { AgentProvider, HarnessConfig } from "./types";
import { DEFAULT_CONFIG } from "./types";

export interface PersistedConfig {
  version: string;
  workDir?: string;
  harnessDir?: string;
  pollIntervalMs?: number;
  heartbeatIntervalMs?: number;
  taskTimeoutMs?: number;
  maxConcurrentWorkers?: number;
  autoSpawn?: boolean;
  autoCommit?: boolean;
  leadProvider?: AgentProvider;
  decomposerModel?: string;
  defaultProvider?: string;
  providers?: Partial<HarnessConfig["providers"]>;
  // Adapter-specific tuning
  adapters?: {
    "claude-code"?: {
      model?: string;
      maxTurns?: number;
      mode?: "print" | "continue" | "resume";
    };
    codex?: {
      model?: string;
      approvalMode?: "suggest" | "auto-edit" | "full-auto";
    };
    cursor?: {
      strategy?: "cli" | "workspace-inject" | "rules-inject";
      resultPollIntervalMs?: number;
    };
  };
}

const CONFIG_VERSION = "0.1";

export function loadConfig(
  workDir?: string,
  overrides?: Partial<HarnessConfig>
): HarnessConfig {
  const dir = resolve(workDir || process.cwd());
  const harnessDir = overrides?.harnessDir || DEFAULT_CONFIG.harnessDir;
  const configPath = join(dir, harnessDir, "config.json");

  let persisted: Partial<PersistedConfig> = {};

  if (existsSync(configPath)) {
    try {
      persisted = JSON.parse(readFileSync(configPath, "utf-8"));
    } catch {
      console.warn(`⚠ Could not parse ${configPath}, using defaults`);
    }
  }

  return {
    ...DEFAULT_CONFIG,
    ...persisted,
    workDir: dir,
    harnessDir: persisted.harnessDir || harnessDir,
    ...overrides,
  };
}

export function saveConfig(workDir: string, config: PersistedConfig): void {
  const harnessDir = config.harnessDir || DEFAULT_CONFIG.harnessDir;
  const dir = join(resolve(workDir), harnessDir);

  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  const configPath = join(dir, "config.json");
  writeFileSync(configPath, JSON.stringify({ ...config, version: CONFIG_VERSION }, null, 2));
}

export function writeDefaultConfig(workDir: string): void {
  const defaultPersisted: PersistedConfig = {
    version: CONFIG_VERSION,
    pollIntervalMs: 1000,
    heartbeatIntervalMs: 5000,
    taskTimeoutMs: 300000,
    maxConcurrentWorkers: 5,
    providers: {
      "claude-code": { enabled: true, command: "claude" },
      cursor: { enabled: true },
      codex: { enabled: true, command: "codex" },
      "gemini-cli": { enabled: false, command: "gemini" },
    },
    adapters: {
      "claude-code": {
        model: "claude-sonnet-4-5",
        maxTurns: 10,
        mode: "print",
      },
      codex: {
        model: "o4-mini",
        approvalMode: "full-auto",
      },
      cursor: {
        strategy: "workspace-inject",
        resultPollIntervalMs: 3000,
      },
    },
  };

  saveConfig(workDir, defaultPersisted);
}

export function getAdapterConfig(
  workDir: string
): PersistedConfig["adapters"] {
  const config = loadConfig(workDir);
  const configPath = join(resolve(workDir), config.harnessDir, "config.json");

  if (!existsSync(configPath)) return {};

  try {
    const persisted: PersistedConfig = JSON.parse(readFileSync(configPath, "utf-8"));
    return persisted.adapters || {};
  } catch {
    return {};
  }
}
