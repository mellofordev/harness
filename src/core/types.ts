/**
 * Harness CLI - Core Type Definitions
 *
 * Defines the complete type system for multi-agent orchestration.
 * Inspired by the hierarchical planner/worker architecture from
 * Cursor's "self-driving codebases" design.
 */

// ─── Agent Identity ──────────────────────────────────────────────

export type AgentProvider = "claude-code" | "cursor" | "codex" | "gemini-cli" | "custom";

export type AgentRole = "planner" | "worker" | "observer";

export type AgentStatus = "idle" | "busy" | "waiting" | "completed" | "failed" | "offline";

export interface AgentInfo {
  id: string;
  provider: AgentProvider;
  role: AgentRole;
  status: AgentStatus;
  pid?: number;
  sessionDir?: string;
  capabilities: string[];
  registeredAt: number;
  lastHeartbeat: number;
  metadata: Record<string, unknown>;
}

// ─── Task System ─────────────────────────────────────────────────

export type TaskStatus = "pending" | "assigned" | "in_progress" | "completed" | "failed" | "cancelled";

export type TaskPriority = "critical" | "high" | "normal" | "low";

export interface Task {
  id: string;
  parentId?: string;           // For hierarchical decomposition
  title: string;
  description: string;
  status: TaskStatus;
  priority: TaskPriority;
  assignedTo?: string;         // Agent ID
  createdBy: string;           // Agent ID of planner
  dependencies: string[];      // Task IDs that must complete first
  files: string[];             // Files this task touches
  result?: TaskResult;
  createdAt: number;
  updatedAt: number;
  startedAt?: number;
  completedAt?: number;
}

export interface TaskResult {
  success: boolean;
  summary: string;
  filesChanged: string[];
  errors?: string[];
  output?: string;
}

// ─── Inter-Agent Messaging ───────────────────────────────────────

export type MessageType =
  | "task_assign"       // Planner → Worker: here's your task
  | "task_update"       // Worker → Planner: progress update
  | "task_complete"     // Worker → Planner: done, here's the result
  | "task_failed"       // Worker → Planner: failed, here's why
  | "handoff"           // Worker → Worker: passing context
  | "query"             // Any → Any: ask a question
  | "response"          // Any → Any: answer a question
  | "heartbeat"         // Any → Bus: I'm still alive
  | "discovery"         // Any → Bus: announce presence
  | "plan_update"       // Planner → All: plan has changed
  | "sync_request"      // Any → Any: request file sync
  | "shutdown";         // Planner → All: shutting down

export interface Message {
  id: string;
  type: MessageType;
  from: string;          // Agent ID
  to: string;            // Agent ID or "*" for broadcast
  payload: unknown;
  timestamp: number;
  correlationId?: string; // For request/response pairs
  ttl?: number;           // Time-to-live in ms
}

// ─── Plan (Hierarchical Decomposition) ───────────────────────────

export interface Plan {
  id: string;
  title: string;
  description: string;
  rootTaskId: string;
  tasks: Task[];
  createdBy: string;
  status: "drafting" | "active" | "completed" | "failed";
  createdAt: number;
  updatedAt: number;
}

// ─── Session State ───────────────────────────────────────────────

export interface HarnessSession {
  id: string;
  workDir: string;
  harnessDir: string;
  agents: AgentInfo[];
  plans: Plan[];
  startedAt: number;
  status: "active" | "paused" | "completed";
}

// ─── Discovery ───────────────────────────────────────────────────

export interface DiscoveryResult {
  provider: AgentProvider;
  pid: number;
  sessionDir?: string;
  command: string;
  detected: boolean;
}

// ─── Configuration ───────────────────────────────────────────────

export interface HarnessConfig {
  workDir: string;
  harnessDir: string;
  pollIntervalMs: number;
  heartbeatIntervalMs: number;
  taskTimeoutMs: number;
  maxConcurrentWorkers: number;
  providers: {
    [key in AgentProvider]?: {
      enabled: boolean;
      command?: string;
      args?: string[];
    };
  };
}

export const DEFAULT_CONFIG: HarnessConfig = {
  workDir: process.cwd(),
  harnessDir: ".harness",
  pollIntervalMs: 1000,
  heartbeatIntervalMs: 5000,
  taskTimeoutMs: 300_000, // 5 minutes
  maxConcurrentWorkers: 10,
  providers: {
    "claude-code": { enabled: true, command: "claude" },
    "cursor": { enabled: true },
    "codex": { enabled: true, command: "codex" },
    "gemini-cli": { enabled: false, command: "gemini" },
    "custom": { enabled: false },
  },
};
