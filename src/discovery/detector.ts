/**
 * Agent Discovery System
 *
 * Detects running AI CLI agent sessions on the local machine.
 * Each provider has its own detection strategy:
 *
 * - Claude Code:  Looks for `claude` processes and ~/.claude/ session data
 * - Cursor:       Looks for Cursor processes and workspace agent sessions
 * - Codex:        Looks for `codex` processes
 * - Gemini CLI:   Looks for `gemini` processes
 *
 * Discovery can also detect agents that have registered themselves
 * with the Harness file bus (self-announced agents).
 */

import { execSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { AgentProvider, DiscoveryResult, AgentInfo } from "../core/types";
import { logger } from "../utils/logger";

interface ProcessInfo {
  pid: number;
  command: string;
  args: string;
}

// ─── Process Detection ─────────────────────────────────────────

function findProcesses(pattern: string): ProcessInfo[] {
  try {
    const platform = process.platform;
    let cmd: string;

    if (platform === "win32") {
      cmd = `wmic process where "commandline like '%${pattern}%'" get processid,commandline /format:csv 2>nul`;
    } else {
      cmd = `ps aux | grep -i "${pattern}" | grep -v grep`;
    }

    const output = execSync(cmd, { encoding: "utf-8", timeout: 5000 }).trim();
    if (!output) return [];

    if (platform === "win32") {
      return output
        .split("\n")
        .slice(1)
        .filter(Boolean)
        .map((line) => {
          const parts = line.split(",");
          return {
            pid: parseInt(parts[parts.length - 1]),
            command: parts.slice(1, -1).join(","),
            args: "",
          };
        });
    }

    return output.split("\n").filter(Boolean).map((line) => {
      const parts = line.trim().split(/\s+/);
      return {
        pid: parseInt(parts[1]),
        command: parts[10] || "",
        args: parts.slice(11).join(" "),
      };
    });
  } catch {
    return [];
  }
}

// ─── Provider-Specific Detectors ───────────────────────────────

function detectClaudeCode(): DiscoveryResult[] {
  const results: DiscoveryResult[] = [];

  // Check for running claude processes
  const processes = findProcesses("claude");
  const claudeProcesses = processes.filter(
    (p) =>
      p.command.includes("claude") &&
      !p.command.includes("claude-desktop") &&
      !p.command.includes("harness")
  );

  for (const proc of claudeProcesses) {
    results.push({
      provider: "claude-code",
      pid: proc.pid,
      command: proc.command,
      detected: true,
    });
  }

  // Check for Claude Code session directories
  const claudeDir = join(homedir(), ".claude");
  if (existsSync(claudeDir)) {
    const projectsDir = join(claudeDir, "projects");
    if (existsSync(projectsDir)) {
      try {
        const projects = readdirSync(projectsDir);
        for (const project of projects) {
          const sessionsDir = join(projectsDir, project);
          if (existsSync(sessionsDir)) {
            // Add as a detected session location
            if (results.length === 0) {
              results.push({
                provider: "claude-code",
                pid: 0,
                sessionDir: sessionsDir,
                command: "claude (session detected)",
                detected: true,
              });
            } else {
              results[0].sessionDir = sessionsDir;
            }
          }
        }
      } catch {
        // Permission denied or other errors
      }
    }
  }

  return results;
}

function detectCursor(): DiscoveryResult[] {
  const results: DiscoveryResult[] = [];

  // Check for running Cursor processes
  const processes = findProcesses("cursor");
  const cursorProcesses = processes.filter(
    (p) => p.command.toLowerCase().includes("cursor") && !p.command.includes("harness")
  );

  for (const proc of cursorProcesses) {
    results.push({
      provider: "cursor",
      pid: proc.pid,
      command: proc.command,
      detected: true,
    });
  }

  // Check for Cursor workspace directory
  const cursorConfigPaths = [
    join(homedir(), ".cursor"),
    join(homedir(), "Library", "Application Support", "Cursor"),           // macOS
    join(homedir(), ".config", "Cursor"),                                   // Linux
    join(homedir(), "AppData", "Roaming", "Cursor"),                       // Windows
  ];

  for (const configPath of cursorConfigPaths) {
    if (existsSync(configPath)) {
      if (results.length > 0) {
        results[0].sessionDir = configPath;
      }
      break;
    }
  }

  return results;
}

function detectCodex(): DiscoveryResult[] {
  const results: DiscoveryResult[] = [];

  // Check for running codex processes
  const processes = findProcesses("codex");
  const codexProcesses = processes.filter(
    (p) => p.command.includes("codex") && !p.command.includes("harness")
  );

  for (const proc of codexProcesses) {
    results.push({
      provider: "codex",
      pid: proc.pid,
      command: proc.command,
      detected: true,
    });
  }

  return results;
}

function detectGeminiCli(): DiscoveryResult[] {
  const results: DiscoveryResult[] = [];

  const processes = findProcesses("gemini");
  const geminiProcesses = processes.filter(
    (p) => p.command.includes("gemini") && !p.command.includes("harness")
  );

  for (const proc of geminiProcesses) {
    results.push({
      provider: "gemini-cli",
      pid: proc.pid,
      command: proc.command,
      detected: true,
    });
  }

  return results;
}

// ─── Discovery Orchestrator ────────────────────────────────────

const DETECTORS: Record<AgentProvider, () => DiscoveryResult[]> = {
  "claude-code": detectClaudeCode,
  "cursor": detectCursor,
  "codex": detectCodex,
  "gemini-cli": detectGeminiCli,
  "custom": () => [],
};

export function discoverAgents(providers?: AgentProvider[]): DiscoveryResult[] {
  const targetProviders = providers || (Object.keys(DETECTORS) as AgentProvider[]);
  const allResults: DiscoveryResult[] = [];

  for (const provider of targetProviders) {
    const detector = DETECTORS[provider];
    if (!detector) continue;

    try {
      logger.debug(`Scanning for ${provider} sessions...`);
      const results = detector();
      allResults.push(...results);

      if (results.length > 0) {
        logger.agent(provider, `Found ${results.length} session(s)`);
      } else {
        logger.debug(`No ${provider} sessions found`);
      }
    } catch (err) {
      logger.warn(`Discovery failed for ${provider}: ${err}`);
    }
  }

  return allResults;
}

// ─── Check CLI Availability ────────────────────────────────────

export function checkCliAvailability(): Record<AgentProvider, boolean> {
  const availability: Record<string, boolean> = {};

  const commands: Record<string, string> = {
    "claude-code": "claude --version",
    "codex": "codex --version",
    "gemini-cli": "gemini --version",
    "cursor": "cursor --version",
  };

  for (const [provider, cmd] of Object.entries(commands)) {
    try {
      execSync(cmd, { encoding: "utf-8", timeout: 5000, stdio: "pipe" });
      availability[provider] = true;
    } catch {
      availability[provider] = false;
    }
  }

  return availability as Record<AgentProvider, boolean>;
}
