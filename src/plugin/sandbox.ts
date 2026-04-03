/**
 * Plugin Sandbox — V8 Isolate-Based Plugin Isolation
 *
 * Uses `isolated-vm` to run untrusted (user-installed) plugins in a separate
 * V8 heap with enforced memory limits and timeout controls. The plugin code
 * runs inside the isolate with no access to Node.js APIs, filesystem, or
 * network. Only the PluginAPI bridge is exposed.
 *
 * Design:
 *   - Bundled plugins (origin: "bundled") are trusted and bypass sandboxing.
 *   - User plugins (origin: "user") run sandboxed by default.
 *   - The bridge exposes: registerTool, registerHook, registerCommand, log, config.
 *   - Tool execute functions are compiled inside the isolate. When the tool is
 *     invoked, params are serialized in and results are serialized out.
 *   - Memory limit enforced at the V8 heap level (default 128MB per plugin).
 *   - Script execution timeout (default 5s for registration, 30s per tool call).
 *
 * Requires: `npm install isolated-vm` (optional dependency)
 *
 * Security alignment:
 *   - NIST AI RMF Govern 1.7: third-party component risk management
 *   - ISO 27001 A.8.1: asset management / software supply chain
 */

import type {
  PluginRecord,
  PluginTool,
  HookName,
  HookHandlerMap,
} from "./types.js";
import type { PluginRegistry } from "./registry.js";

// ─── isolated-vm Types (minimal) ────────────────────────────────────────────

// We dynamically import isolated-vm so it remains optional.
// These interfaces match the subset of the API we use.
interface IvmIsolate {
  compileScript(code: string): Promise<IvmScript>;
  createContext(): Promise<IvmContext>;
  dispose(): void;
  isDisposed: boolean;
}

interface IvmContext {
  global: IvmReference;
  release(): void;
}

interface IvmScript {
  run(context: IvmContext, options?: { timeout?: number }): Promise<unknown>;
}

interface IvmReference {
  set(key: string, value: unknown, options?: { copy?: boolean }): Promise<void>;
  get(key: string, options?: { reference?: boolean }): Promise<unknown>;
  apply(
    receiver: unknown,
    args?: unknown[],
    options?: { result?: { copy?: boolean; promise?: boolean }; arguments?: { copy?: boolean }; timeout?: number }
  ): Promise<unknown>;
  deref(): unknown;
  release(): void;
}

interface IvmExternalCopy {
  copy(): unknown;
  copyInto(): unknown;
  release(): void;
}

interface IvmModule {
  Isolate: new (options?: { memoryLimit?: number }) => IvmIsolate;
  Reference: new (value: unknown) => IvmReference;
  ExternalCopy: new (value: unknown, options?: { transferOut?: boolean }) => IvmExternalCopy;
}

// ─── Sandbox Configuration ──────────────────────────────────────────────────

export interface SandboxConfig {
  /** Memory limit in MB for the V8 isolate (default: 128) */
  memoryLimitMB: number;

  /** Timeout in ms for plugin registration script (default: 5000) */
  registrationTimeoutMs: number;

  /** Timeout in ms for each tool execute call (default: 30000) */
  toolTimeoutMs: number;
}

const DEFAULT_SANDBOX_CONFIG: SandboxConfig = {
  memoryLimitMB: 128,
  registrationTimeoutMs: 5_000,
  toolTimeoutMs: 30_000,
};

// ─── Availability Check ─────────────────────────────────────────────────────

let _ivm: IvmModule | null = null;
let _ivmChecked = false;

/**
 * Check whether isolated-vm is available. Caches the result.
 */
export async function isSandboxAvailable(): Promise<boolean> {
  if (_ivmChecked) return _ivm !== null;
  _ivmChecked = true;

  try {
    _ivm = await import("isolated-vm") as unknown as IvmModule;
    return true;
  } catch {
    return false;
  }
}

function requireIvm(): IvmModule {
  if (!_ivm) throw new Error("isolated-vm is not installed. Run: npm install isolated-vm");
  return _ivm;
}

// ─── Plugin Sandbox ─────────────────────────────────────────────────────────

/**
 * Sandboxed execution environment for a single plugin.
 *
 * Lifecycle:
 *   1. new PluginSandbox(config)
 *   2. await sandbox.loadPlugin(code, record, registry, pluginConfig)
 *   3. Tool calls are proxied through the sandbox automatically
 *   4. sandbox.dispose() when done
 */
export class PluginSandbox {
  private isolate: IvmIsolate | null = null;
  private context: IvmContext | null = null;
  private config: SandboxConfig;
  private toolExecutors: Map<string, IvmReference> = new Map();
  private pluginId: string = "";

  constructor(config: Partial<SandboxConfig> = {}) {
    this.config = { ...DEFAULT_SANDBOX_CONFIG, ...config };
  }

  /**
   * Load and register a plugin inside the sandbox.
   *
   * The plugin code must be vanilla JavaScript (no imports, no require).
   * It receives a `pluginAPI` global with the bridge methods.
   */
  async loadPlugin(
    code: string,
    record: PluginRecord,
    registry: PluginRegistry,
    pluginConfig: Record<string, unknown>
  ): Promise<void> {
    const ivm = requireIvm();
    this.pluginId = record.id;

    // Create isolate with memory limit
    this.isolate = new ivm.Isolate({ memoryLimit: this.config.memoryLimitMB });
    this.context = await this.isolate.createContext();

    const jail = this.context.global;

    // ─── Expose bridge API ──────────────────────────────────────

    // pluginAPI.config — read-only copy of plugin config
    await jail.set("__config", new ivm.ExternalCopy(pluginConfig).copyInto(), { copy: true });

    // pluginAPI.log — proxied to console with plugin prefix
    const prefix = `[sandbox:${record.id}]`;
    await jail.set(
      "__log_info",
      new ivm.Reference((msg: string) => console.info(prefix, msg))
    );
    await jail.set(
      "__log_warn",
      new ivm.Reference((msg: string) => console.warn(prefix, msg))
    );
    await jail.set(
      "__log_error",
      new ivm.Reference((msg: string) => console.error(prefix, msg))
    );
    await jail.set(
      "__log_debug",
      new ivm.Reference((msg: string) => console.debug(prefix, msg))
    );

    // __registerTool — called from inside the isolate to register a tool
    const sandbox = this;
    await jail.set(
      "__registerTool",
      new ivm.Reference((
        name: string,
        description: string,
        parametersJson: string,
        executeRef: IvmReference
      ) => {
        // Store the execute reference for later invocation
        sandbox.toolExecutors.set(name, executeRef);

        const parameters = JSON.parse(parametersJson);

        // Create a PluginTool that proxies execution through the sandbox
        const tool: PluginTool = {
          name,
          description,
          parameters,
          execute: async (_toolCallId: string, params: Record<string, unknown>) => {
            return sandbox.executeToolInSandbox(name, params);
          },
        };

        registry.registerTool(record.id, tool);
        if (!record.toolNames.includes(name)) {
          record.toolNames.push(name);
        }
      })
    );

    // __registerCommand — called from inside the isolate to register a command
    await jail.set(
      "__registerCommand",
      new ivm.Reference((name: string, description: string, executeRef: IvmReference) => {
        registry.registerCommand({
          pluginId: record.id,
          command: {
            name,
            description,
            execute: async (args: string[]) => {
              const result = await executeRef.apply(undefined, [
                new ivm.ExternalCopy(args).copyInto(),
              ], {
                result: { copy: true, promise: true },
                timeout: sandbox.config.toolTimeoutMs,
              });
              return String(result ?? "");
            },
          },
        });
      })
    );

    // __registerHook — called from inside the isolate to register a hook
    await jail.set(
      "__registerHook",
      new ivm.Reference((hookName: string, handlerRef: IvmReference, priority: number) => {
        // For sandboxed hooks, we proxy the event through serialization
        const handler = async (event: unknown) => {
          const result = await handlerRef.apply(undefined, [
            new ivm.ExternalCopy(event).copyInto(),
          ], {
            result: { copy: true, promise: true },
            timeout: sandbox.config.toolTimeoutMs,
          });
          return result as Record<string, unknown> | void;
        };

        registry.registerHook({
          pluginId: record.id,
          hookName: hookName as HookName,
          handler: handler as HookHandlerMap[HookName],
          priority,
        });

        if (!record.hookNames.includes(hookName)) {
          record.hookNames.push(hookName);
        }
      })
    );

    // ─── Compile and run plugin bootstrap ───────────────────────

    // Wrap the user code in an IIFE that provides a clean pluginAPI object
    const wrappedCode = `
      "use strict";
      const pluginAPI = {
        id: ${JSON.stringify(record.id)},
        name: ${JSON.stringify(record.name)},
        version: ${JSON.stringify(record.version)},
        config: __config,
        log: {
          info:  function(msg) { __log_info.applyIgnored(undefined, [msg]); },
          warn:  function(msg) { __log_warn.applyIgnored(undefined, [msg]); },
          error: function(msg) { __log_error.applyIgnored(undefined, [msg]); },
          debug: function(msg) { __log_debug.applyIgnored(undefined, [msg]); },
        },
        registerTool: function(opts) {
          var execRef = new __ivm_Reference(opts.execute);
          __registerTool.applyIgnored(undefined, [
            opts.name,
            opts.description,
            JSON.stringify(opts.parameters),
            execRef
          ]);
        },
        registerCommand: function(opts) {
          var execRef = new __ivm_Reference(opts.execute);
          __registerCommand.applyIgnored(undefined, [
            opts.name,
            opts.description,
            execRef
          ]);
        },
        registerHook: function(hookName, handler, hookOpts) {
          var handlerRef = new __ivm_Reference(handler);
          __registerHook.applyIgnored(undefined, [
            hookName,
            handlerRef,
            (hookOpts && hookOpts.priority) || 0
          ]);
        },
      };

      // Execute user plugin code
      (function() {
        ${code}
      })();
    `;

    // Expose ivm.Reference constructor inside the isolate for creating references
    await jail.set("__ivm_Reference", ivm.Reference);

    const script = await this.isolate.compileScript(wrappedCode);
    await script.run(this.context, { timeout: this.config.registrationTimeoutMs });

    console.info(
      `  [sandbox] Plugin "${record.id}" loaded in isolate ` +
      `(${this.config.memoryLimitMB}MB limit, ${record.toolNames.length} tools)`
    );
  }

  /**
   * Execute a tool's handler inside the sandbox.
   */
  private async executeToolInSandbox(
    toolName: string,
    params: Record<string, unknown>
  ): Promise<{ content: string }> {
    const ivm = requireIvm();
    const executeRef = this.toolExecutors.get(toolName);

    if (!executeRef) {
      return { content: `Error: sandboxed tool "${toolName}" has no execute handler.` };
    }

    if (this.isolate?.isDisposed) {
      return { content: `Error: sandbox for plugin "${this.pluginId}" has been disposed.` };
    }

    try {
      const result = await executeRef.apply(undefined, [
        "sandboxed-call",
        new ivm.ExternalCopy(params).copyInto(),
      ], {
        result: { copy: true, promise: true },
        timeout: this.config.toolTimeoutMs,
      }) as Record<string, unknown> | string | null;

      if (typeof result === "string") {
        return { content: result };
      }
      if (result && typeof result === "object" && "content" in result) {
        return { content: String(result.content) };
      }
      return { content: JSON.stringify(result ?? "No output from sandboxed tool.") };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);

      if (msg.includes("disposed")) {
        return { content: `Error: sandbox for "${this.pluginId}" was terminated (likely memory limit exceeded).` };
      }
      if (msg.includes("Script execution timed out")) {
        return { content: `Error: tool "${toolName}" exceeded ${this.config.toolTimeoutMs}ms timeout.` };
      }

      return { content: `Sandbox error in "${toolName}": ${msg}` };
    }
  }

  /**
   * Release all sandbox resources.
   */
  dispose(): void {
    for (const ref of this.toolExecutors.values()) {
      try {
        ref.release();
      } catch {
        // Already released
      }
    }
    this.toolExecutors.clear();

    if (this.context) {
      try {
        this.context.release();
      } catch {
        // Already released
      }
      this.context = null;
    }

    if (this.isolate && !this.isolate.isDisposed) {
      this.isolate.dispose();
    }
    this.isolate = null;
  }

  /**
   * Whether this sandbox's isolate is still alive.
   */
  get isAlive(): boolean {
    return this.isolate !== null && !this.isolate.isDisposed;
  }
}

// ─── Sandbox Manager ────────────────────────────────────────────────────────

/**
 * Manages sandbox instances across all user plugins.
 * Created once at startup, disposed on shutdown.
 */
export class SandboxManager {
  private sandboxes: Map<string, PluginSandbox> = new Map();

  /**
   * Create a sandbox for a plugin. Returns null if isolated-vm is unavailable.
   */
  async createSandbox(
    pluginId: string,
    config?: Partial<SandboxConfig>
  ): Promise<PluginSandbox | null> {
    const available = await isSandboxAvailable();
    if (!available) return null;

    const sandbox = new PluginSandbox(config);
    this.sandboxes.set(pluginId, sandbox);
    return sandbox;
  }

  /**
   * Get an existing sandbox by plugin ID.
   */
  getSandbox(pluginId: string): PluginSandbox | undefined {
    return this.sandboxes.get(pluginId);
  }

  /**
   * Dispose all sandboxes. Call on shutdown.
   */
  disposeAll(): void {
    for (const [id, sandbox] of this.sandboxes) {
      try {
        sandbox.dispose();
      } catch (err) {
        console.warn(`  [sandbox] Failed to dispose sandbox for "${id}":`, err);
      }
    }
    this.sandboxes.clear();
  }

  /**
   * Number of active sandboxes.
   */
  get count(): number {
    return this.sandboxes.size;
  }
}
