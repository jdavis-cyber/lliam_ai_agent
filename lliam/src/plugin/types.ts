/**
 * Plugin System Type Definitions
 *
 * Defines the core interfaces for Lliam's plugin architecture:
 * - PluginManifest: declarative metadata (lliam.plugin.json)
 * - PluginAPI: runtime API surface provided to plugins during registration
 * - Tools, Hooks, Commands, Services: registration primitives
 *
 * Design inspired by OpenClaw's plugin system, simplified for single-user local use.
 */

import type { Message, ToolDefinition, ToolResult, ToolExecuteFn } from "../types/index.js";

// ─── Plugin Manifest (lliam.plugin.json) ────────────────────────────────────

export interface PluginManifest {
  /** Unique plugin identifier (e.g., "core.echo", "memory-tools") */
  id: string;

  /** Human-readable name */
  name: string;

  /** Semver version string */
  version: string;

  /** Short description of what this plugin does */
  description: string;

  /** Entry point relative to manifest directory (default: "./index.ts") */
  main?: string;

  /** Plugin kind for special handling */
  kind?: PluginKind;

  /** JSON Schema for plugin-specific configuration */
  configSchema?: Record<string, unknown>;
}

export type PluginKind = "memory" | "channel" | "browser" | "general";

// ─── Plugin Record (runtime tracking) ───────────────────────────────────────

export interface PluginRecord {
  /** Plugin ID from manifest */
  id: string;

  /** Plugin name from manifest */
  name: string;

  /** Version from manifest */
  version: string;

  /** Description from manifest */
  description: string;

  /** Plugin kind */
  kind: PluginKind;

  /** Filesystem path to plugin root directory */
  source: string;

  /** Where the plugin was discovered */
  origin: PluginOrigin;

  /** Whether the plugin is currently active */
  enabled: boolean;

  /** Load status */
  status: PluginStatus;

  /** Error message if status is "error" */
  error?: string;

  /** Names of tools registered by this plugin */
  toolNames: string[];

  /** Hook names registered by this plugin */
  hookNames: string[];
}

export type PluginOrigin = "bundled" | "user";
export type PluginStatus = "loaded" | "disabled" | "error" | "pending";

// ─── Hook System ────────────────────────────────────────────────────────────

/**
 * All lifecycle hook names.
 *
 * Modifying hooks (sequential, priority-ordered, can alter flow):
 *   - before_agent_start: inject context/memories into system prompt
 *   - before_tool_call: inspect/modify/block tool invocations
 *   - message_sending: modify or cancel outbound messages
 *
 * Fire-and-forget hooks (parallel, all handlers run):
 *   - agent_end: post-processing after agent completes
 *   - after_tool_call: observe tool results (no modification)
 *   - message_received: observe inbound messages
 *   - session_start: session created
 *   - session_end: session ended
 *   - gateway_start: server started
 *   - gateway_stop: server stopping
 */
export type HookName =
  | "before_agent_start"
  | "agent_end"
  | "before_tool_call"
  | "after_tool_call"
  | "message_received"
  | "message_sending"
  | "session_start"
  | "session_end"
  | "gateway_start"
  | "gateway_stop";

/** Hooks that modify flow — executed sequentially in priority order. */
export const MODIFYING_HOOKS: ReadonlySet<HookName> = new Set([
  "before_agent_start",
  "before_tool_call",
  "message_sending",
]);

/** Hooks that fire-and-forget — executed in parallel. */
export const PARALLEL_HOOKS: ReadonlySet<HookName> = new Set([
  "agent_end",
  "after_tool_call",
  "message_received",
  "session_start",
  "session_end",
  "gateway_start",
  "gateway_stop",
]);

// ─── Hook Event Types ───────────────────────────────────────────────────────

export interface BeforeAgentStartEvent {
  prompt: string;
  sessionId: string;
  messages: Message[];
}

export interface BeforeAgentStartResult {
  /** Additional system prompt content to prepend */
  systemPrompt?: string;
  /** Context block to prepend before the conversation */
  prependContext?: string;
}

export interface AgentEndEvent {
  sessionId: string;
  messages: Message[];
  response: string;
  tokenUsage?: { inputTokens: number; outputTokens: number };
}

export interface BeforeToolCallEvent {
  toolName: string;
  toolCallId: string;
  params: Record<string, unknown>;
  sessionId: string;
}

export interface BeforeToolCallResult {
  /** Modified parameters (replaces original) */
  params?: Record<string, unknown>;
  /** If true, block tool execution entirely */
  block?: boolean;
  /** Reason displayed to agent when blocked */
  blockReason?: string;
}

export interface AfterToolCallEvent {
  toolName: string;
  toolCallId: string;
  params: Record<string, unknown>;
  result: ToolResult;
  sessionId: string;
  durationMs: number;
}

export interface MessageReceivedEvent {
  sessionId: string;
  channel: string;
  from: string;
  content: string;
}

export interface MessageSendingEvent {
  sessionId: string;
  channel: string;
  to: string;
  content: string;
}

export interface MessageSendingResult {
  /** Modified content (replaces original) */
  content?: string;
  /** If true, cancel sending entirely */
  cancel?: boolean;
}

export interface SessionLifecycleEvent {
  sessionId: string;
}

export interface GatewayLifecycleEvent {
  port: number;
  host: string;
}

// ─── Hook Handler Type Map ──────────────────────────────────────────────────

/**
 * Maps hook names to their handler signatures.
 * Modifying hooks return a result object; fire-and-forget hooks return void.
 */
export interface HookHandlerMap {
  before_agent_start: (
    event: BeforeAgentStartEvent,
  ) => Promise<BeforeAgentStartResult | void>;

  agent_end: (event: AgentEndEvent) => Promise<void>;

  before_tool_call: (
    event: BeforeToolCallEvent,
  ) => Promise<BeforeToolCallResult | void>;

  after_tool_call: (event: AfterToolCallEvent) => Promise<void>;

  message_received: (event: MessageReceivedEvent) => Promise<void>;

  message_sending: (
    event: MessageSendingEvent,
  ) => Promise<MessageSendingResult | void>;

  session_start: (event: SessionLifecycleEvent) => Promise<void>;
  session_end: (event: SessionLifecycleEvent) => Promise<void>;

  gateway_start: (event: GatewayLifecycleEvent) => Promise<void>;
  gateway_stop: (event: GatewayLifecycleEvent) => Promise<void>;
}

// ─── Hook Registration ──────────────────────────────────────────────────────

export interface HookRegistration<K extends HookName = HookName> {
  /** Which plugin registered this hook */
  pluginId: string;

  /** Hook lifecycle name */
  hookName: K;

  /** Handler function */
  handler: HookHandlerMap[K];

  /**
   * Priority (higher runs first for modifying hooks).
   * Default: 0. Memory plugins typically use 100, security plugins use 200.
   */
  priority: number;
}

// ─── Tool Registration ──────────────────────────────────────────────────────

/**
 * A tool factory that creates tool definitions at runtime.
 * Receives the tool context and returns one or more tool definitions.
 */
export type ToolFactory = (ctx: ToolContext) => PluginTool | PluginTool[] | null;

export interface ToolContext {
  sessionId?: string;
  pluginConfig?: Record<string, unknown>;
}

/**
 * A plugin-registered tool extends the base ToolDefinition with an execute function.
 */
export interface PluginTool extends ToolDefinition {
  /** Execute the tool and return a result */
  execute: ToolExecuteFn;
}

export interface ToolRegistration {
  /** Which plugin registered this tool */
  pluginId: string;

  /** Tool factory or static tool definition */
  factory: ToolFactory;

  /** Whether this tool is optional (must be explicitly enabled) */
  optional: boolean;
}

// ─── Command Registration ───────────────────────────────────────────────────

/**
 * A direct command that bypasses the LLM.
 * Example: /memory search "my preferences"
 */
export interface PluginCommand {
  /** Command name (e.g., "memory") */
  name: string;

  /** Description shown in help */
  description: string;

  /** Execute the command */
  execute: (args: string[], sessionId?: string) => Promise<string>;
}

export interface CommandRegistration {
  pluginId: string;
  command: PluginCommand;
}

// ─── Service Registration ───────────────────────────────────────────────────

/**
 * A background service managed by the plugin system.
 * Services are started when the gateway starts and stopped on shutdown.
 */
export interface PluginService {
  /** Service ID (must be unique) */
  id: string;

  /** Called on gateway start */
  start: () => Promise<void> | void;

  /** Called on gateway shutdown */
  stop: () => Promise<void> | void;
}

export interface ServiceRegistration {
  pluginId: string;
  service: PluginService;
}

// ─── Plugin Logger ──────────────────────────────────────────────────────────

export interface PluginLogger {
  debug: (msg: string, ...args: unknown[]) => void;
  info: (msg: string, ...args: unknown[]) => void;
  warn: (msg: string, ...args: unknown[]) => void;
  error: (msg: string, ...args: unknown[]) => void;
}

// ─── Plugin API ─────────────────────────────────────────────────────────────

/**
 * The API surface provided to plugins during registration.
 * This is the primary interface plugins use to extend Lliam.
 */
export interface PluginAPI {
  /** Plugin ID */
  id: string;

  /** Plugin name */
  name: string;

  /** Plugin version */
  version: string;

  /** Plugin-specific configuration (from app config) */
  pluginConfig: Record<string, unknown>;

  /** Logger scoped to this plugin */
  logger: PluginLogger;

  /** Resolve a user-relative path (e.g., "~/data" → "/home/user/data") */
  resolvePath: (input: string) => string;

  /**
   * Register a tool or tool factory.
   * Tools are made available to Claude for function calling.
   */
  registerTool: (
    tool: PluginTool | ToolFactory,
    opts?: { optional?: boolean },
  ) => void;

  /**
   * Register a lifecycle hook handler.
   * @param hookName - The lifecycle event to hook into
   * @param handler - The handler function
   * @param opts - Options including priority (higher = runs first for modifying hooks)
   */
  registerHook: <K extends HookName>(
    hookName: K,
    handler: HookHandlerMap[K],
    opts?: { priority?: number },
  ) => void;

  /**
   * Register a direct command (bypasses LLM).
   * Commands are invoked via /command-name in the CLI or Web UI.
   */
  registerCommand: (command: PluginCommand) => void;

  /**
   * Register a background service.
   * Services are started/stopped with the gateway.
   */
  registerService: (service: PluginService) => void;

  /**
   * Get a registered service instance by ID.
   * Used by plugins to access shared services (e.g., memory-manager).
   */
  getService?: (serviceId: string) => unknown;
}

// ─── Plugin Module ──────────────────────────────────────────────────────────

/**
 * The shape of a plugin's default export.
 * A plugin module must export this interface as its default export.
 */
export interface PluginModule {
  /** Plugin ID (must match manifest) */
  id: string;

  /** Human-readable name */
  name: string;

  /** Version string */
  version?: string;

  /** Description */
  description?: string;

  /**
   * Registration function called during plugin loading.
   * This is where the plugin registers tools, hooks, commands, and services.
   */
  register: (api: PluginAPI) => void | Promise<void>;
}
