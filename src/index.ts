/**
 * Harness CLI — Public API
 *
 * Import from here when using harness as a library in your own scripts.
 */

// Core
export { Orchestrator } from "./core/orchestrator";
export { loadConfig, saveConfig, writeDefaultConfig, getAdapterConfig } from "./core/config";
export type {
  AgentInfo,
  AgentProvider,
  AgentRole,
  AgentStatus,
  Task,
  TaskResult,
  TaskStatus,
  Message,
  MessageType,
  Plan,
  HarnessSession,
  HarnessConfig,
  DiscoveryResult,
} from "./core/types";
export { DEFAULT_CONFIG } from "./core/types";

// Transport
export { FileBus } from "./transport/file-bus";

// Planner
export { Planner } from "./planner/planner";
export type { TaskDefinition, PlannerOptions, PlanStatus } from "./planner/planner";
export { Worker } from "./planner/worker";
export type { WorkerOptions } from "./planner/worker";

// Agent adapters
export { REGISTRY, getAdapter, isProviderAvailable } from "./agents/index";
export { BaseAgentAdapter } from "./agents/base";
export type { AgentAdapter, TaskContext, ExecutionOptions } from "./agents/base";
export { ClaudeCodeAdapter } from "./agents/claude-code";
export { CursorAdapter } from "./agents/cursor";
export { CodexAdapter } from "./agents/codex";

// Discovery
export { discoverAgents, checkCliAvailability } from "./discovery/detector";

// Watch
export { startWatch } from "./commands/watch";

// Utils
export { logger } from "./utils/logger";
export * from "./utils/id";
