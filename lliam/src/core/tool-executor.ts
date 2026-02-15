/**
 * Tool Executor
 *
 * Manages the execution of plugin-registered tools.
 * Wraps each invocation with:
 *   1. before_tool_call hooks (can modify params or block execution)
 *   2. Actual tool execution
 *   3. after_tool_call hooks (observe result, no modification)
 *
 * All tool invocations are logged for audit trail.
 */

import type { ToolResult } from "../types/index.js";
import type { PluginTool } from "../plugin/types.js";
import type { HookRunner } from "../plugin/hook-runner.js";

// ─── Tool Execution Log ─────────────────────────────────────────────────────

export interface ToolExecutionLog {
  toolName: string;
  toolCallId: string;
  params: Record<string, unknown>;
  result: ToolResult | null;
  blocked: boolean;
  blockReason?: string;
  durationMs: number;
  error?: string;
  timestamp: number;
}

// ─── Tool Executor ──────────────────────────────────────────────────────────

export class ToolExecutor {
  private tools: Map<string, PluginTool> = new Map();
  private hookRunner: HookRunner;
  private executionLog: ToolExecutionLog[] = [];
  private maxLogSize: number;

  constructor(hookRunner: HookRunner, maxLogSize: number = 1000) {
    this.hookRunner = hookRunner;
    this.maxLogSize = maxLogSize;
  }

  /**
   * Set the available tools (called after plugin loading).
   */
  setTools(tools: PluginTool[]): void {
    this.tools.clear();
    for (const tool of tools) {
      this.tools.set(tool.name, tool);
    }
  }

  /**
   * Get a tool by name.
   */
  getTool(name: string): PluginTool | undefined {
    return this.tools.get(name);
  }

  /**
   * Get all available tool names.
   */
  getToolNames(): string[] {
    return Array.from(this.tools.keys());
  }

  /**
   * Get tool definitions for passing to Claude (without execute functions).
   */
  getToolDefinitions(): Array<{
    name: string;
    description: string;
    input_schema: Record<string, unknown>;
  }> {
    return Array.from(this.tools.values()).map((tool) => ({
      name: tool.name,
      description: tool.description,
      input_schema: tool.parameters,
    }));
  }

  /**
   * Execute a tool by name, wrapping with before/after hooks.
   *
   * Flow:
   *   1. Validate tool exists
   *   2. Run before_tool_call hooks (may modify params or block)
   *   3. Execute tool
   *   4. Run after_tool_call hooks
   *   5. Log execution
   *   6. Return result
   */
  async execute(
    toolName: string,
    toolCallId: string,
    params: Record<string, unknown>,
    sessionId?: string
  ): Promise<ToolResult> {
    const startTime = Date.now();
    const tool = this.tools.get(toolName);

    if (!tool) {
      const result: ToolResult = {
        content: `Tool "${toolName}" not found`,
        isError: true,
      };
      this.logExecution({
        toolName,
        toolCallId,
        params,
        result,
        blocked: false,
        durationMs: Date.now() - startTime,
        error: "Tool not found",
        timestamp: startTime,
      });
      return result;
    }

    // ── 1. Run before_tool_call hooks ─────────────────────────────────────
    const hookResult = await this.hookRunner.runBeforeToolCall({
      toolName,
      toolCallId,
      params,
      sessionId: sessionId ?? "unknown",
    });

    if (hookResult.blocked) {
      const result: ToolResult = {
        content: `Tool call blocked: ${hookResult.blockReason ?? "Blocked by plugin"}`,
        isError: true,
      };
      this.logExecution({
        toolName,
        toolCallId,
        params,
        result,
        blocked: true,
        blockReason: hookResult.blockReason,
        durationMs: Date.now() - startTime,
        timestamp: startTime,
      });
      return result;
    }

    // Use (possibly modified) params from hooks
    const finalParams = hookResult.params;

    // ── 2. Execute tool ───────────────────────────────────────────────────
    let result: ToolResult;
    let error: string | undefined;

    try {
      result = await tool.execute(toolCallId, finalParams);
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
      result = {
        content: `Tool execution failed: ${error}`,
        isError: true,
      };
    }

    const durationMs = Date.now() - startTime;

    // ── 3. Run after_tool_call hooks ──────────────────────────────────────
    // Fire-and-forget — errors don't affect the result
    await this.hookRunner.run("after_tool_call", {
      toolName,
      toolCallId,
      params: finalParams,
      result,
      sessionId: sessionId ?? "unknown",
      durationMs,
    });

    // ── 4. Log execution ──────────────────────────────────────────────────
    this.logExecution({
      toolName,
      toolCallId,
      params: finalParams,
      result,
      blocked: false,
      durationMs,
      error,
      timestamp: startTime,
    });

    return result;
  }

  // ─── Execution Log ──────────────────────────────────────────────────────

  /**
   * Get the execution log (most recent first).
   */
  getLog(): readonly ToolExecutionLog[] {
    return this.executionLog;
  }

  /**
   * Clear the execution log.
   */
  clearLog(): void {
    this.executionLog = [];
  }

  private logExecution(entry: ToolExecutionLog): void {
    this.executionLog.unshift(entry);

    // Trim log to max size
    if (this.executionLog.length > this.maxLogSize) {
      this.executionLog = this.executionLog.slice(0, this.maxLogSize);
    }
  }
}
