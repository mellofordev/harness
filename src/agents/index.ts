/**
 * Agent Adapter Registry
 *
 * Single place to register, look up, and instantiate provider adapters.
 *
 * Adding a new provider:
 *   1. Create `src/agents/<your-provider>.ts` extending BaseAgentAdapter
 *   2. Import and register it here with REGISTRY.register(...)
 *   3. Add the provider name to the AgentProvider union in core/types.ts
 *
 * That's it. Worker.ts and the rest of the system never need to change.
 */

import type { AgentProvider } from "../core/types";
import type { AgentAdapter } from "./base";
import { ClaudeCodeAdapter, type ClaudeCodeOptions } from "./claude-code";
import { CursorAdapter, type CursorAdapterOptions } from "./cursor";
import { CodexAdapter, type CodexAdapterOptions } from "./codex";

// ─── Per-provider constructor option types ──────────────────────

type ProviderOptions = {
  "claude-code": ClaudeCodeOptions;
  "cursor": CursorAdapterOptions;
  "codex": CodexAdapterOptions;
  "gemini-cli": Record<string, unknown>;  // Placeholder until implemented
  "custom": Record<string, unknown>;
};

// ─── Factory functions ──────────────────────────────────────────

type AdapterFactory<P extends AgentProvider> = (
  options?: Partial<ProviderOptions[P]>
) => AgentAdapter;

class AdapterRegistry {
  private factories = new Map<AgentProvider, AdapterFactory<AgentProvider>>();

  register<P extends AgentProvider>(provider: P, factory: AdapterFactory<P>): this {
    this.factories.set(provider, factory as AdapterFactory<AgentProvider>);
    return this;
  }

  /**
   * Create an adapter instance for the given provider.
   * Returns null if the provider isn't registered.
   */
  create<P extends AgentProvider>(
    provider: P,
    options?: Partial<ProviderOptions[P]>
  ): AgentAdapter | null {
    const factory = this.factories.get(provider);
    if (!factory) return null;
    return factory(options);
  }

  /**
   * Check whether an adapter is registered for a provider.
   */
  has(provider: AgentProvider): boolean {
    return this.factories.has(provider);
  }

  /**
   * List all registered provider names.
   */
  list(): AgentProvider[] {
    return [...this.factories.keys()];
  }

  /**
   * Check availability of all registered providers concurrently.
   * Returns a map of provider → isAvailable.
   */
  async checkAll(): Promise<Record<AgentProvider, boolean>> {
    const results: Record<string, boolean> = {};

    await Promise.all(
      this.list().map(async (provider) => {
        const adapter = this.create(provider);
        if (adapter) {
          results[provider] = await adapter.isAvailable();
        }
      })
    );

    return results as Record<AgentProvider, boolean>;
  }
}

// ─── Singleton registry ─────────────────────────────────────────

export const REGISTRY = new AdapterRegistry()
  .register("claude-code", (opts) => new ClaudeCodeAdapter(opts))
  .register("cursor",      (opts) => new CursorAdapter(opts))
  .register("codex",       (opts) => new CodexAdapter(opts));
  // Add more here:
  // .register("gemini-cli", (opts) => new GeminiCliAdapter(opts))

// ─── Convenience helpers ────────────────────────────────────────

/**
 * Get an adapter for a provider. Throws if the provider isn't registered.
 */
export function getAdapter(
  provider: AgentProvider,
  options?: Partial<ProviderOptions[AgentProvider]>
): AgentAdapter {
  const adapter = REGISTRY.create(provider, options);
  if (!adapter) {
    throw new Error(
      `No adapter registered for provider "${provider}". ` +
      `Available: ${REGISTRY.list().join(", ")}`
    );
  }
  return adapter;
}

/**
 * Check if a provider has an available CLI tool on the system.
 */
export async function isProviderAvailable(provider: AgentProvider): Promise<boolean> {
  const adapter = REGISTRY.create(provider);
  if (!adapter) return false;
  return adapter.isAvailable();
}

// Re-export types so consumers only need to import from this index
export type { AgentAdapter, TaskContext, ExecutionOptions } from "./base";
export { BaseAgentAdapter } from "./base";
export { ClaudeCodeAdapter } from "./claude-code";
export { CursorAdapter } from "./cursor";
export { CodexAdapter } from "./codex";
