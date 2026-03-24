/**
 * Minimal structured logger for Harness CLI
 */

type LogLevel = "debug" | "info" | "warn" | "error";

const COLORS = {
  debug: "\x1b[90m",   // gray
  info: "\x1b[36m",    // cyan
  warn: "\x1b[33m",    // yellow
  error: "\x1b[31m",   // red
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
};

const ICONS = {
  debug: "·",
  info: "●",
  warn: "▲",
  error: "✖",
};

let currentLevel: LogLevel = "info";

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

function shouldLog(level: LogLevel): boolean {
  return LEVEL_ORDER[level] >= LEVEL_ORDER[currentLevel];
}

function formatTime(): string {
  return new Date().toISOString().split("T")[1].slice(0, 12);
}

export const logger = {
  setLevel(level: LogLevel) {
    currentLevel = level;
  },

  debug(msg: string, data?: Record<string, unknown>) {
    if (!shouldLog("debug")) return;
    const meta = data ? ` ${COLORS.dim}${JSON.stringify(data)}${COLORS.reset}` : "";
    console.log(`${COLORS.debug}${ICONS.debug} ${formatTime()} ${msg}${COLORS.reset}${meta}`);
  },

  info(msg: string, data?: Record<string, unknown>) {
    if (!shouldLog("info")) return;
    const meta = data ? ` ${COLORS.dim}${JSON.stringify(data)}${COLORS.reset}` : "";
    console.log(`${COLORS.info}${ICONS.info} ${formatTime()} ${msg}${COLORS.reset}${meta}`);
  },

  warn(msg: string, data?: Record<string, unknown>) {
    if (!shouldLog("warn")) return;
    const meta = data ? ` ${COLORS.dim}${JSON.stringify(data)}${COLORS.reset}` : "";
    console.warn(`${COLORS.warn}${ICONS.warn} ${formatTime()} ${msg}${COLORS.reset}${meta}`);
  },

  error(msg: string, data?: Record<string, unknown>) {
    if (!shouldLog("error")) return;
    const meta = data ? ` ${COLORS.dim}${JSON.stringify(data)}${COLORS.reset}` : "";
    console.error(`${COLORS.error}${ICONS.error} ${formatTime()} ${msg}${COLORS.reset}${meta}`);
  },

  // Special formatted outputs
  banner(text: string) {
    const line = "─".repeat(Math.max(text.length + 4, 40));
    console.log(`\n${COLORS.bold}${COLORS.info}${line}${COLORS.reset}`);
    console.log(`${COLORS.bold}  ${text}${COLORS.reset}`);
    console.log(`${COLORS.info}${line}${COLORS.reset}\n`);
  },

  agent(provider: string, action: string, detail?: string) {
    const providerColors: Record<string, string> = {
      "claude-code": "\x1b[35m",  // magenta
      "cursor": "\x1b[34m",       // blue
      "codex": "\x1b[32m",        // green
      "gemini-cli": "\x1b[33m",   // yellow
    };
    const color = providerColors[provider] || COLORS.info;
    const d = detail ? ` ${COLORS.dim}(${detail})${COLORS.reset}` : "";
    console.log(`${color}⬡ [${provider}]${COLORS.reset} ${action}${d}`);
  },

  task(taskId: string, status: string, title: string) {
    const statusColors: Record<string, string> = {
      pending: COLORS.dim,
      assigned: "\x1b[34m",
      in_progress: "\x1b[33m",
      completed: "\x1b[32m",
      failed: "\x1b[31m",
    };
    const color = statusColors[status] || COLORS.reset;
    console.log(`  ${color}◆ ${taskId}${COLORS.reset} [${status}] ${title}`);
  },

  message(from: string, to: string, type: string) {
    console.log(`${COLORS.dim}  ↳ ${from} → ${to}: ${type}${COLORS.reset}`);
  },
};
