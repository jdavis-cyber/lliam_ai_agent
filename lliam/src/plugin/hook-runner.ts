/**
 * Hook Runner
 *
 * Executes lifecycle hooks from the plugin registry.
 *
 * Two execution modes:
 *
 * 1. Modifying hooks (before_agent_start, before_tool_call, message_sending):
 *    - Execute sequentially in priority order (highest first)
 *    - Each handler can return modifications that accumulate
 *    - A handler can block/cancel the operation
 *
 * 2. Fire-and-forget hooks (agent_end, after_tool_call, etc.):
 *    - Execute all handlers in parallel
 *    - Errors are caught and logged (never crash the server)
 *    - No return value aggregation
 */

import type {
  HookName,
  HookHandlerMap,
  HookRegistration,
} from "./types.js";
import { MODIFYING_HOOKS as ModifyingHooks } from "./types.js";
import type { PluginRegistry } from "./registry.js";

// ─── Result Types ───────────────────────────────────────────────────────────

/**
 * Aggregated result from running before_agent_start hooks.
 */
export interface AgentStartHookResult {
  /** Additional system prompt segments to prepend */
  systemPromptAdditions: string[];
  /** Context blocks to prepend before conversation */
  prependContextBlocks: string[];
}

/**
 * Aggregated result from running before_tool_call hooks.
 */
export interface ToolCallHookResult {
  /** Final (possibly modified) parameters */
  params: Record<string, unknown>;
  /** Whether the tool call was blocked */
  blocked: boolean;
  /** Reason for blocking (if blocked) */
  blockReason?: string;
}

/**
 * Aggregated result from running message_sending hooks.
 */
export interface MessageSendingHookResult {
  /** Final (possibly modified) content */
  content: string;
  /** Whether sending was cancelled */
  cancelled: boolean;
}

// ─── Hook Runner ────────────────────────────────────────────────────────────

export class HookRunner {
  constructor(private registry: PluginRegistry) {}

  /**
   * Run a hook by name with the appropriate execution mode.
   *
   * For modifying hooks, returns the aggregated result.
   * For fire-and-forget hooks, returns void.
   */
  async run<K extends HookName>(
    hookName: K,
    event: Parameters<HookHandlerMap[K]>[0]
  ): Promise<void> {
    const hooks = this.registry.getHooks(hookName);
    if (hooks.length === 0) return;

    if (ModifyingHooks.has(hookName)) {
      // Sequential execution for modifying hooks
      await this.runSequential(hooks, event);
    } else {
      // Parallel execution for fire-and-forget hooks
      await this.runParallel(hooks, event);
    }
  }

  /**
   * Run before_agent_start hooks and return aggregated modifications.
   */
  async runBeforeAgentStart(
    event: Parameters<HookHandlerMap["before_agent_start"]>[0]
  ): Promise<AgentStartHookResult> {
    const result: AgentStartHookResult = {
      systemPromptAdditions: [],
      prependContextBlocks: [],
    };

    const hooks = this.registry.getHooks("before_agent_start");
    for (const hook of hooks) {
      try {
        const handlerResult = await (hook.handler as HookHandlerMap["before_agent_start"])(event);
        if (handlerResult) {
          if (handlerResult.systemPrompt) {
            result.systemPromptAdditions.push(handlerResult.systemPrompt);
          }
          if (handlerResult.prependContext) {
            result.prependContextBlocks.push(handlerResult.prependContext);
          }
        }
      } catch (err) {
        console.error(
          `[hooks] before_agent_start handler from "${hook.pluginId}" failed:`,
          err instanceof Error ? err.message : err
        );
      }
    }

    return result;
  }

  /**
   * Run before_tool_call hooks and return aggregated modifications.
   * If any handler blocks the call, execution stops immediately.
   */
  async runBeforeToolCall(
    event: Parameters<HookHandlerMap["before_tool_call"]>[0]
  ): Promise<ToolCallHookResult> {
    const result: ToolCallHookResult = {
      params: { ...event.params },
      blocked: false,
    };

    const hooks = this.registry.getHooks("before_tool_call");
    for (const hook of hooks) {
      try {
        const handlerResult = await (hook.handler as HookHandlerMap["before_tool_call"])(event);
        if (handlerResult) {
          if (handlerResult.block) {
            result.blocked = true;
            result.blockReason = handlerResult.blockReason ?? "Blocked by plugin";
            return result; // Stop immediately
          }
          if (handlerResult.params) {
            result.params = handlerResult.params;
            // Update event params for subsequent handlers
            event.params = handlerResult.params;
          }
        }
      } catch (err) {
        console.error(
          `[hooks] before_tool_call handler from "${hook.pluginId}" failed:`,
          err instanceof Error ? err.message : err
        );
      }
    }

    return result;
  }

  /**
   * Run message_sending hooks and return aggregated modifications.
   * If any handler cancels, execution stops immediately.
   */
  async runMessageSending(
    event: Parameters<HookHandlerMap["message_sending"]>[0]
  ): Promise<MessageSendingHookResult> {
    const result: MessageSendingHookResult = {
      content: event.content,
      cancelled: false,
    };

    const hooks = this.registry.getHooks("message_sending");
    for (const hook of hooks) {
      try {
        const handlerResult = await (hook.handler as HookHandlerMap["message_sending"])(event);
        if (handlerResult) {
          if (handlerResult.cancel) {
            result.cancelled = true;
            return result; // Stop immediately
          }
          if (handlerResult.content !== undefined) {
            result.content = handlerResult.content;
            // Update event content for subsequent handlers
            event.content = handlerResult.content;
          }
        }
      } catch (err) {
        console.error(
          `[hooks] message_sending handler from "${hook.pluginId}" failed:`,
          err instanceof Error ? err.message : err
        );
      }
    }

    return result;
  }

  // ─── Internal Execution Modes ───────────────────────────────────────────

  /**
   * Execute hooks sequentially in priority order.
   * Used for modifying hooks (called via the specific run* methods above).
   */
  private async runSequential<K extends HookName>(
    hooks: HookRegistration<K>[],
    event: Parameters<HookHandlerMap[K]>[0]
  ): Promise<void> {
    for (const hook of hooks) {
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await (hook.handler as any)(event);
      } catch (err) {
        console.error(
          `[hooks] ${hook.hookName} handler from "${hook.pluginId}" failed:`,
          err instanceof Error ? err.message : err
        );
      }
    }
  }

  /**
   * Execute all hooks in parallel (fire-and-forget).
   * Errors are caught and logged per-handler.
   */
  private async runParallel<K extends HookName>(
    hooks: HookRegistration<K>[],
    event: Parameters<HookHandlerMap[K]>[0]
  ): Promise<void> {
    await Promise.allSettled(
      hooks.map(async (hook) => {
        try {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          await (hook.handler as any)(event);
        } catch (err) {
          console.error(
            `[hooks] ${hook.hookName} handler from "${hook.pluginId}" failed:`,
            err instanceof Error ? err.message : err
          );
        }
      })
    );
  }
}
