/**
 * AgentRunner Factory
 *
 * Single place to bootstrap the full plugin-enabled agent pipeline:
 *   1. Initialize KeyManager (AES-256-GCM key from macOS Keychain) — R-01, R-02
 *   2. Load plugins from core + user directories
 *   3. Create HookRunner from registry
 *   4. Create ToolExecutor from registry (with durable audit logging) — R-07, R-10
 *   5. Return a factory fn that creates AgentRunner instances per session
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
import { keyManager } from "../security/key-manager.js";
import type { AgentConfig } from "../types/index.js";
import type { PluginRegistry } from "../plugin/registry.js";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface RunnerFactory {
  create(agentConfig: AgentConfig, apiKey?: string): AgentRunner;
  registry: PluginRegistry;
  hookRunner: HookRunner;
  toolExecutor: ToolExecutor;
}

// ─── Bootstrap ────────────────────────────────────────────────────────────────

/**
 * Bootstrap the plugin system and return a factory for creating AgentRunners.
 * Call this once at server startup, then use factory.create() per session.
 *
 * Initializes KeyManager first — all downstream storage (sessions, SQLite)
 * will encrypt/decrypt transparently once the key is in memory.
 */
export async function bootstrapRunnerFactory(options: {
  extraPluginDirs?: string[];
  pluginConfigs?: Record<string, Record<string, unknown>>;
  disabledPlugins?: string[];
}): Promise<RunnerFactory> {
  const { extraPluginDirs = [], pluginConfigs = {}, disabledPlugins = [] } = options;

  // ── 1. Initialize encryption key (R-01, R-02) ─────────────────────────
  await keyManager.init();
  console.log("  KeyManager: ready (AES-256-GCM, key in memory only).");

  // Resolve the project root relative to this file
  const thisFile = fileURLToPath(import.meta.url);
  const projectRoot = resolve(thisFile, "../../../");

  const corePluginsDir = join(projectRoot, "plugins", "core");
  const executivePluginsDir = join(projectRoot, "plugins", "executive");
  const userPluginsDir = join(homedir(), ".lliam", "plugins");

  const searchPaths = [
    { dir: corePluginsDir, origin: "bundled" as const },
    { dir: executivePluginsDir, origin: "bundled" as const },
    { dir: userPluginsDir, origin: "user" as const },
    ...extraPluginDirs.map((dir) => ({ dir, origin: "user" as const })),
  ];

  // ── 2. Load plugins ───────────────────────────────────────────────────
  const registry = await loadPlugins({ searchPaths, pluginConfigs, disabledPlugins });

  const summary = registry.getSummary();
  console.log(`  Plugins loaded: ${summary.plugins} (${summary.tools} tools, ${summary.hooks} hooks)`);

  const errors = registry.getDiagnostics().filter((d) => d.level === "error");
  for (const err of errors) {
    console.warn(`  Plugin error [${err.pluginId}]: ${err.message}`);
  }

  // ── 3. Create shared runner components ────────────────────────────────
  const hookRunner = new HookRunner(registry);
  const toolExecutor = new ToolExecutor(hookRunner);
  toolExecutor.setTools(registry.resolveTools());

  // ── 4. Start services ─────────────────────────────────────────────────
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
