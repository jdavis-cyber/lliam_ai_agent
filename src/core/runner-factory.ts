/**
 * AgentRunner Factory
 *
 * Single place to bootstrap the full plugin-enabled agent pipeline:
 *   1. Load plugins from core + user directories
 *   2. Create HookRunner from registry
 *   3. Create ToolExecutor from registry
 *   4. Return a factory fn that creates AgentRunner instances per session
 *
 * All entry points (CLI, WebSocket, channels) use this factory so that
 * plugins are loaded once and shared across all sessions.
 */

import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";

import { loadPlugins } from "../plugin/loader.js";
import { HookRunner } from "../plugin/hook-runner.js";
import { ToolExecutor } from "./tool-executor.js";
import { AgentRunner, type AgentRunnerConfig } from "./agent-runner.js";
import type { AgentConfig } from "../types/index.js";
import type { PluginRegistry } from "../plugin/registry.js";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface RunnerFactory {
  /** Create a new AgentRunner sharing the loaded plugin registry */
  create(agentConfig: AgentConfig, apiKey?: string): AgentRunner;

  /** The shared plugin registry (for diagnostics/status) */
  registry: PluginRegistry;

  /** The shared HookRunner */
  hookRunner: HookRunner;

  /** The shared ToolExecutor */
  toolExecutor: ToolExecutor;
}

// ─── Bootstrap ────────────────────────────────────────────────────────────────

/**
 * Bootstrap the plugin system and return a factory for creating AgentRunners.
 * Call this once at server startup, then use factory.create() per session.
 */
export async function bootstrapRunnerFactory(options: {
  /** Extra plugin directories to load from */
  extraPluginDirs?: string[];
  /** Per-plugin config overrides */
  pluginConfigs?: Record<string, Record<string, unknown>>;
  /** Plugin IDs to disable */
  disabledPlugins?: string[];
}): Promise<RunnerFactory> {
  const { extraPluginDirs = [], pluginConfigs = {}, disabledPlugins = [] } = options;

  // Resolve the project root relative to this file
  const thisFile = fileURLToPath(import.meta.url);
  const projectRoot = resolve(thisFile, "../../../");

  // Core plugins (shipped with Lliam)
  const corePluginsDir = join(projectRoot, "plugins", "core");

  // Executive plugins (the ones we just built)
  const executivePluginsDir = join(projectRoot, "plugins", "executive");

  // User plugins (~/.lliam/plugins)
  const userPluginsDir = join(homedir(), ".lliam", "plugins");

  const searchPaths = [
    { dir: corePluginsDir, origin: "bundled" as const },
    { dir: executivePluginsDir, origin: "bundled" as const },
    { dir: userPluginsDir, origin: "user" as const },
    ...extraPluginDirs.map((dir) => ({ dir, origin: "user" as const })),
  ];

  const registry = await loadPlugins({ searchPaths, pluginConfigs, disabledPlugins });

  // Log plugin load summary
  const summary = registry.getSummary();
  console.log(`  Plugins loaded: ${summary.plugins} (${summary.tools} tools, ${summary.hooks} hooks)`);

  const errors = registry.getDiagnostics().filter((d) => d.level === "error");
  for (const err of errors) {
    console.warn(`  Plugin error [${err.pluginId}]: ${err.message}`);
  }

  const hookRunner = new HookRunner(registry);
  const toolExecutor = new ToolExecutor(registry, hookRunner);

  // Start all registered services
  const services = registry.getServices();
  for (const svc of services) {
    try {
      await svc.service.start();
      console.log(`  Service started: ${svc.service.id}`);
    } catch (err) {
      console.error(`  Service failed to start [${svc.service.id}]: ${err}`);
    }
  }

  return {
    registry,
    hookRunner,
    toolExecutor,
    create(agentConfig: AgentConfig, apiKey?: string): AgentRunner {
      return new AgentRunner({
        agentConfig,
        apiKey,
        hookRunner,
        toolExecutor,
      } satisfies AgentRunnerConfig);
    },
  };
}
