/**
 * Plugin Registry
 *
 * Central store for all plugin registrations — tools, hooks, commands, services.
 * Provides lookup, conflict detection, and diagnostic tracking.
 *
 * Thread-safe for single-user use (no concurrent mutation expected).
 */

import type {
  PluginRecord,
  ToolRegistration,
  HookRegistration,
  HookName,
  CommandRegistration,
  ServiceRegistration,
  PluginTool,
  ToolFactory,
  ToolContext,
} from "./types.js";

// ─── Diagnostic Types ───────────────────────────────────────────────────────

export interface PluginDiagnostic {
  pluginId: string;
  level: "info" | "warn" | "error";
  message: string;
  timestamp: number;
}

// ─── Plugin Registry ────────────────────────────────────────────────────────

export class PluginRegistry {
  /** Metadata for each loaded plugin */
  private plugins: Map<string, PluginRecord> = new Map();

  /** Tool registrations indexed by plugin ID */
  private tools: ToolRegistration[] = [];

  /** Hook registrations */
  private hooks: HookRegistration[] = [];

  /** Command registrations indexed by command name */
  private commands: Map<string, CommandRegistration> = new Map();

  /** Service registrations indexed by service ID */
  private services: Map<string, ServiceRegistration> = new Map();

  /** Diagnostic messages from loading/registration */
  private diagnostics: PluginDiagnostic[] = [];

  // ─── Plugin Record Management ───────────────────────────────────────────

  /**
   * Register a plugin record (metadata only, no code execution).
   */
  registerPlugin(record: PluginRecord): void {
    if (this.plugins.has(record.id)) {
      this.addDiagnostic(
        record.id,
        "warn",
        `Plugin "${record.id}" already registered — overwriting.`
      );
    }
    this.plugins.set(record.id, record);
  }

  /**
   * Get a plugin record by ID.
   */
  getPlugin(id: string): PluginRecord | undefined {
    return this.plugins.get(id);
  }

  /**
   * Get all registered plugin records.
   */
  getPlugins(): PluginRecord[] {
    return Array.from(this.plugins.values());
  }

  /**
   * Update a plugin's status (e.g., after successful load or error).
   */
  updatePluginStatus(
    id: string,
    status: PluginRecord["status"],
    error?: string
  ): void {
    const record = this.plugins.get(id);
    if (record) {
      record.status = status;
      record.error = error;
    }
  }

  // ─── Tool Registration ──────────────────────────────────────────────────

  /**
   * Register a tool or tool factory from a plugin.
   * Detects naming conflicts and logs diagnostics.
   */
  registerTool(
    pluginId: string,
    toolOrFactory: PluginTool | ToolFactory,
    opts: { optional?: boolean } = {}
  ): void {
    // Wrap static tools in a factory
    const factory: ToolFactory =
      typeof toolOrFactory === "function"
        ? toolOrFactory
        : () => toolOrFactory;

    this.tools.push({
      pluginId,
      factory,
      optional: opts.optional ?? false,
    });

    // Track tool name on plugin record (best-effort, factory may fail)
    const record = this.plugins.get(pluginId);
    if (record) {
      try {
        const resolved = factory({});
        if (resolved) {
          const toolArray = Array.isArray(resolved) ? resolved : [resolved];
          for (const tool of toolArray) {
            if (!record.toolNames.includes(tool.name)) {
              record.toolNames.push(tool.name);
            }
          }
        }
      } catch {
        // Factory may need runtime context — tool names will be tracked during resolveTools
      }
    }
  }

  /**
   * Resolve all tool factories into concrete PluginTool instances.
   * Handles deduplication and conflict logging.
   */
  resolveTools(ctx: ToolContext = {}): PluginTool[] {
    const resolved: PluginTool[] = [];
    const seenNames = new Set<string>();

    for (const reg of this.tools) {
      try {
        const result = reg.factory(ctx);
        if (!result) continue;

        const toolArray = Array.isArray(result) ? result : [result];
        for (const tool of toolArray) {
          if (seenNames.has(tool.name)) {
            this.addDiagnostic(
              reg.pluginId,
              "warn",
              `Tool "${tool.name}" conflicts with existing registration — skipping.`
            );
            continue;
          }
          seenNames.add(tool.name);
          resolved.push(tool);
        }
      } catch (err) {
        this.addDiagnostic(
          reg.pluginId,
          "error",
          `Tool factory failed: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }

    return resolved;
  }

  /**
   * Get raw tool registrations (for inspection/testing).
   */
  getToolRegistrations(): readonly ToolRegistration[] {
    return this.tools;
  }

  // ─── Hook Registration ──────────────────────────────────────────────────

  /**
   * Register a lifecycle hook handler.
   */
  registerHook<K extends HookName>(registration: HookRegistration<K>): void {
    this.hooks.push(registration as HookRegistration);

    // Track on plugin record
    const record = this.plugins.get(registration.pluginId);
    if (record && !record.hookNames.includes(registration.hookName)) {
      record.hookNames.push(registration.hookName);
    }
  }

  /**
   * Get all hooks for a given hook name, sorted by priority (highest first).
   */
  getHooks<K extends HookName>(hookName: K): HookRegistration<K>[] {
    return (this.hooks as HookRegistration<K>[])
      .filter((h) => h.hookName === hookName)
      .sort((a, b) => b.priority - a.priority);
  }

  /**
   * Get all hook registrations (for inspection/testing).
   */
  getAllHooks(): readonly HookRegistration[] {
    return this.hooks;
  }

  // ─── Command Registration ───────────────────────────────────────────────

  /**
   * Register a direct command.
   * Commands must have unique names.
   */
  registerCommand(registration: CommandRegistration): void {
    const name = registration.command.name;

    if (this.commands.has(name)) {
      this.addDiagnostic(
        registration.pluginId,
        "warn",
        `Command "/${name}" conflicts with existing registration — overwriting.`
      );
    }

    this.commands.set(name, registration);
  }

  /**
   * Get a command by name.
   */
  getCommand(name: string): CommandRegistration | undefined {
    return this.commands.get(name);
  }

  /**
   * Get all registered commands.
   */
  getCommands(): CommandRegistration[] {
    return Array.from(this.commands.values());
  }

  // ─── Service Registration ───────────────────────────────────────────────

  /**
   * Register a background service.
   * Services must have unique IDs.
   */
  registerService(registration: ServiceRegistration): void {
    const id = registration.service.id;

    if (this.services.has(id)) {
      this.addDiagnostic(
        registration.pluginId,
        "warn",
        `Service "${id}" conflicts with existing registration — overwriting.`
      );
    }

    this.services.set(id, registration);
  }

  /**
   * Get a service by ID.
   */
  getService(id: string): ServiceRegistration | undefined {
    return this.services.get(id);
  }

  /**
   * Get all registered services.
   */
  getServices(): ServiceRegistration[] {
    return Array.from(this.services.values());
  }

  // ─── Diagnostics ────────────────────────────────────────────────────────

  /**
   * Add a diagnostic message.
   */
  addDiagnostic(
    pluginId: string,
    level: PluginDiagnostic["level"],
    message: string
  ): void {
    this.diagnostics.push({
      pluginId,
      level,
      message,
      timestamp: Date.now(),
    });
  }

  /**
   * Get all diagnostic messages.
   */
  getDiagnostics(): readonly PluginDiagnostic[] {
    return this.diagnostics;
  }

  /**
   * Get diagnostics for a specific plugin.
   */
  getPluginDiagnostics(pluginId: string): PluginDiagnostic[] {
    return this.diagnostics.filter((d) => d.pluginId === pluginId);
  }

  // ─── Summary ────────────────────────────────────────────────────────────

  /**
   * Get a summary of the registry state.
   */
  getSummary(): {
    plugins: number;
    tools: number;
    hooks: number;
    commands: number;
    services: number;
    errors: number;
  } {
    return {
      plugins: this.plugins.size,
      tools: this.tools.length,
      hooks: this.hooks.length,
      commands: this.commands.size,
      services: this.services.size,
      errors: this.diagnostics.filter((d) => d.level === "error").length,
    };
  }
}
