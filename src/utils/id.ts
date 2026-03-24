/**
 * Simple ID generation utilities using crypto.randomUUID
 */
import { randomUUID } from "node:crypto";

export function generateId(prefix: string = ""): string {
  const uuid = randomUUID();
  const short = uuid.split("-")[0];
  return prefix ? `${prefix}_${short}` : short;
}

export function agentId(provider: string): string {
  return generateId(provider.replace("-", ""));
}

export function taskId(): string {
  return generateId("task");
}

export function messageId(): string {
  return generateId("msg");
}

export function planId(): string {
  return generateId("plan");
}

export function sessionId(): string {
  return generateId("session");
}
