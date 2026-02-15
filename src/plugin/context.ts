/**
 * Plugin Context Builder
 *
 * Constructs the PluginAPI object passed to each plugin during registration.
 * Each plugin gets its own scoped API instance with a dedicated logger,
 * config section, and path resolver.
 */

import { homedir } from "node:os";
import { resolve, isAbsolute } from "node:path";
import type {
  PluginAPI,
  PluginLogger,
  PluginRecord,
  PluginTool,
  ToolFactory,
  PluginCommand,
  PluginService,
  HookName,
  HookHandlerMap,
} from "./types.js";
import type { PluginRegistry } from "./registry.js";

// ─── Plugin Logger Factory ──────────────────────────────────────────────────

/**
 * Create a logger scoped to a specific plugin.
 * Prefixes all messages with [plugin-id] for easy filtering.
 */
function createPluginLogger(pluginId: string): PluginLogger {
  const prefix = `[plugin:${pluginId}]`;
  return {
    debug: (msg: string, ...args: unknown[]) =>
      console.debug(prefix, msg, ...args),
    info: (msg: string, ...args: unknown[]) =>
      console.info(prefix, msg, ...args),
    warn: (msg: string, ...args: unknown[]) =>
      console.warn(prefix, msg, ...args),
    error: (msg: string, ...args: unknown[]) =>
      console.error(prefix, msg, ...args),
  };
}

// ─── Path Resolver ──────────────────────────────────────────────────────────

/**
 * Resolve user-relative paths.
 * - "~/foo" → "/home/user/foo"
 * - "./foo" → resolved relative to cwd
 * - "/foo" → kept as-is
 */
function resolvePath(input: string): string {
  if (input.startsWith("~/") || input === "~") {
    return resolve(homedir(), input.slice(2));
  }
  if (isAbsolute(input)) {
    return input;
  }
  return resolve(process.cwd(), input);
}

// ─── Plugin API Builder ─────────────────────────────────────────────────────

/**
 * Build a PluginAPI instance for a specific plugin.
 *
 * The API is scoped to the plugin — registrations are attributed to the plugin ID,
 * and the logger is prefixed with the plugin name.
 */
export function buildPluginAPI(
  record: PluginRecord,
  registry: PluginRegistry,
  pluginConfig: Record<string, unknown> = {}
): PluginAPI {
  const logger = createPluginLogger(record.id);

  return {
    id: record.id,
    name: record.name,
    version: record.version,
    pluginConfig,
    logger,
    resolvePath,

    registerTool(
      toolOrFactory: PluginTool | ToolFactory,
      opts?: { optional?: boolean }
    ): void {
      registry.registerTool(record.id, toolOrFactory, opts);
      logger.debug(`Registered tool(s)`);
    },

    registerHook<K extends HookName>(
      hookName: K,
      handler: HookHandlerMap[K],
      opts?: { priority?: number }
    ): void {
      registry.registerHook({
        pluginId: record.id,
        hookName,
        handler,
        priority: opts?.priority ?? 0,
      });
      logger.debug(`Registered hook: ${hookName} (priority: ${opts?.priority ?? 0})`);
    },

    registerCommand(command: PluginCommand): void {
      registry.registerCommand({
        pluginId: record.id,
        command,
      });
      logger.debug(`Registered command: /${command.name}`);
    },

    registerService(service: PluginService): void {
      registry.registerService({
        pluginId: record.id,
        service,
      });
      logger.debug(`Registered service: ${service.id}`);
    },

    getService(serviceId: string): unknown {
      const reg = registry.getService(serviceId);
      return reg?.service ?? undefined;
    },
  };
}
