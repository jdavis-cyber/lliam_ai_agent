/**
 * Tool Executor
 *
 * Manages the execution of plugin-registered tools.
 * Wraps each invocation with:
 *   1. before_tool_call hooks (can modify params or block execution)
 *   2. Actual tool execution
 *   3. after_tool_call hooks (observe result, no modification)
 *   4. In-memory log (capped, for current session diagnostics)
 *   5. Durable audit log via AuditLogger (R-07, R-10)
 *      — params are SHA-256 hashed, never written in full
 */

import type { ToolResult } from "../types/index.js";
import type { PluginTool } from "../plugin/types.js";
import type { HookRunner } from "../plugin/hook-runner.js";
import { auditLogger } from "../security/audit-logger.js";

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

  getTool(name: string): PluginTool | undefined {
    return this.tools.get(name);
  }

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
   *   5. Log to in-memory ring buffer + durable audit log (params hashed)
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
      const entry: ToolExecutionLog = {
        toolName,
        toolCallId,
        params,
        result,
        blocked: false,
        durationMs: Date.now() - startTime,
        error: "Tool not found",
        timestamp: startTime,
      };
      this.logExecution(entry, sessionId);
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
      const entry: ToolExecutionLog = {
        toolName,
        toolCallId,
        params,
        result,
        blocked: true,
        blockReason: hookResult.blockReason,
        durationMs: Date.now() - startTime,
        timestamp: startTime,
      };
      this.logExecution(entry, sessionId);
      return result;
    }

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
    await this.hookRunner.run("after_tool_call", {
      toolName,
      toolCallId,
      params: finalParams,
      result,
      sessionId: sessionId ?? "unknown",
      durationMs,
    });

    // ── 4. Log (in-memory + durable) ──────────────────────────────────────
    const entry: ToolExecutionLog = {
      toolName,
      toolCallId,
      params: finalParams,
      result,
      blocked: false,
      durationMs,
      error,
      timestamp: startTime,
    };
    this.logExecution(entry, sessionId);

    return result;
  }

  // ─── Execution Log ──────────────────────────────────────────────────────

  getLog(): readonly ToolExecutionLog[] {
    return this.executionLog;
  }

  clearLog(): void {
    this.executionLog = [];
  }

  private logExecution(entry: ToolExecutionLog, sessionId?: string): void {
    // ── In-memory ring buffer (diagnostics) ───────────────────────────────
    this.executionLog.unshift(entry);
    if (this.executionLog.length > this.maxLogSize) {
      this.executionLog = this.executionLog.slice(0, this.maxLogSize);
    }

    // ── Durable audit log (R-07, R-10) ────────────────────────────────────
    // Params are hashed inside auditLogger.log() — never written in plaintext
    try {
      auditLogger.log(entry, sessionId ?? "unknown");
    } catch {
      // Audit log failure must not crash the agent
      // In a production hardened environment this would alert on-call
    }
  }
}
