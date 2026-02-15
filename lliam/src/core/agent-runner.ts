/**
 * Agent Runner
 *
 * High-level orchestrator that combines:
 *   - Agent (Claude API calls)
 *   - Plugin tools (registered by plugins, passed to Claude as tool definitions)
 *   - Hook runner (lifecycle hooks before/after agent execution)
 *   - Tool executor (runs tool calls with hook wrapping)
 *
 * This is the primary entry point for processing user messages in the gateway.
 * The original Agent class handles the raw Claude API interaction;
 * this class adds the plugin layer on top.
 *
 * Flow:
 *   1. before_agent_start hooks → inject context/memories
 *   2. Send message to Claude (with tool definitions)
 *   3. If Claude requests tool calls → execute via ToolExecutor (with hooks)
 *   4. Loop back to Claude with tool results until no more tool calls
 *   5. agent_end hooks → post-processing
 */

import Anthropic from "@anthropic-ai/sdk";
import type {
  AgentConfig,
  Message,
  StreamChunkCallback,
  TokenUsage,
  ToolCall,
} from "../types/index.js";
import type { HookRunner } from "../plugin/hook-runner.js";
import type { ToolExecutor } from "./tool-executor.js";

const DEFAULT_SYSTEM_PROMPT = `You are Lliam, a personal AI assistant built for a senior Program Manager and AI Governance Strategist. You are structured, precise, and operate as a strategic partner — not a generic assistant.

Core traits:
- Start with key takeaways, then provide detail
- Use structured formats (tables, matrices, bullet points) when appropriate
- Prioritize clarity, logic, and decision-usefulness over verbosity
- Maintain a peer-to-peer, professional tone
- When asked about governance, compliance, or risk — provide depth

You are running locally on the user's machine. All data stays local. You have no access to external systems unless explicitly connected via plugins.`;

// ─── Types ──────────────────────────────────────────────────────────────────

export interface AgentRunnerConfig {
  /** Agent configuration for Claude API */
  agentConfig: AgentConfig;

  /** API key (or reads from env) */
  apiKey?: string;

  /** Hook runner for lifecycle events */
  hookRunner: HookRunner;

  /** Tool executor for plugin tools */
  toolExecutor: ToolExecutor;

  /** Maximum tool-call loops per message (prevent infinite loops) */
  maxToolRounds?: number;
}

export interface RunMessageResult {
  /** Final text response from Claude */
  content: string;

  /** Token usage across all rounds */
  tokenUsage: TokenUsage;

  /** Model used */
  model: string;

  /** All tool calls made during this run */
  toolCalls: ToolCall[];

  /** Session ID this run was associated with */
  sessionId: string;
}

// ─── Agent Runner ───────────────────────────────────────────────────────────

export class AgentRunner {
  private client: Anthropic;
  private config: AgentConfig;
  private hookRunner: HookRunner;
  private toolExecutor: ToolExecutor;
  private maxToolRounds: number;

  constructor(runnerConfig: AgentRunnerConfig) {
    const key = runnerConfig.apiKey ?? process.env.ANTHROPIC_API_KEY;
    if (!key) {
      throw new Error(
        "ANTHROPIC_API_KEY is required. Set it in your environment or .env file."
      );
    }

    this.client = new Anthropic({ apiKey: key });
    this.config = runnerConfig.agentConfig;
    this.hookRunner = runnerConfig.hookRunner;
    this.toolExecutor = runnerConfig.toolExecutor;
    this.maxToolRounds = runnerConfig.maxToolRounds ?? 10;
  }

  /**
   * Process a user message with full hook and tool integration.
   *
   * @param userMessage - The user's input text
   * @param sessionId - The session this message belongs to
   * @param history - Conversation history for context
   * @param onChunk - Optional callback for streaming text chunks
   */
  async runMessage(
    userMessage: string,
    sessionId: string,
    history: Message[],
    onChunk?: StreamChunkCallback
  ): Promise<RunMessageResult> {
    // Validate input
    if (!userMessage.trim()) {
      throw new Error("Message cannot be empty.");
    }
    if (userMessage.length > 100_000) {
      throw new Error("Message exceeds maximum length of 100,000 characters.");
    }

    // ── 1. Run before_agent_start hooks ───────────────────────────────────
    const hookResult = await this.hookRunner.runBeforeAgentStart({
      prompt: userMessage,
      sessionId,
      messages: history,
    });

    // Build system prompt with hook additions
    let systemPrompt = this.config.systemPrompt ?? DEFAULT_SYSTEM_PROMPT;
    if (hookResult.systemPromptAdditions.length > 0) {
      systemPrompt += "\n\n" + hookResult.systemPromptAdditions.join("\n\n");
    }

    // Build context prefix (e.g., recalled memories)
    const contextPrefix = hookResult.prependContextBlocks.length > 0
      ? hookResult.prependContextBlocks.join("\n\n") + "\n\n"
      : "";

    // ── 2. Build API messages from history ────────────────────────────────
    const apiMessages: Anthropic.Messages.MessageParam[] = [];

    for (const msg of history) {
      apiMessages.push({
        role: msg.role as "user" | "assistant",
        content: msg.content,
      });
    }

    // Add current user message (with context prefix if any)
    const augmentedMessage = contextPrefix
      ? contextPrefix + userMessage
      : userMessage;

    apiMessages.push({ role: "user", content: augmentedMessage });

    // ── 3. Get tool definitions ───────────────────────────────────────────
    const toolDefs = this.toolExecutor.getToolDefinitions();
    const tools: Anthropic.Messages.Tool[] = toolDefs.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.input_schema as Anthropic.Messages.Tool.InputSchema,
    }));

    // ── 4. Execute with tool loop ─────────────────────────────────────────
    let totalUsage: TokenUsage = { inputTokens: 0, outputTokens: 0 };
    const allToolCalls: ToolCall[] = [];
    let finalContent = "";
    let model = this.config.model;
    let round = 0;

    while (round < this.maxToolRounds) {
      round++;

      // Call Claude
      const response = await this.callClaude(
        systemPrompt,
        apiMessages,
        tools.length > 0 ? tools : undefined,
        round === 1 ? onChunk : undefined // Only stream first round
      );

      // Accumulate token usage
      totalUsage.inputTokens += response.usage.inputTokens;
      totalUsage.outputTokens += response.usage.outputTokens;
      model = response.model;

      // Process response content blocks
      const textParts: string[] = [];
      const toolUseBlocks: Array<{
        id: string;
        name: string;
        input: Record<string, unknown>;
      }> = [];

      for (const block of response.contentBlocks) {
        if (block.type === "text") {
          textParts.push(block.text);
        } else if (block.type === "tool_use") {
          toolUseBlocks.push({
            id: block.id,
            name: block.name,
            input: block.input as Record<string, unknown>,
          });
        }
      }

      finalContent = textParts.join("");

      // If no tool calls, we're done
      if (toolUseBlocks.length === 0) {
        break;
      }

      // ── Execute tool calls ────────────────────────────────────────────
      // Add assistant message with tool_use blocks to conversation
      apiMessages.push({
        role: "assistant",
        content: response.contentBlocks,
      });

      // Execute each tool and collect results
      const toolResults: Anthropic.Messages.ToolResultBlockParam[] = [];

      for (const toolUse of toolUseBlocks) {
        const result = await this.toolExecutor.execute(
          toolUse.name,
          toolUse.id,
          toolUse.input,
          sessionId
        );

        allToolCalls.push({
          id: toolUse.id,
          name: toolUse.name,
          input: toolUse.input,
        });

        toolResults.push({
          type: "tool_result",
          tool_use_id: toolUse.id,
          content: result.content,
          is_error: result.isError ?? false,
        });
      }

      // Add tool results to conversation
      apiMessages.push({
        role: "user",
        content: toolResults,
      });
    }

    // ── 5. Run agent_end hooks ────────────────────────────────────────────
    await this.hookRunner.run("agent_end", {
      sessionId,
      messages: history,
      response: finalContent,
      tokenUsage: {
        inputTokens: totalUsage.inputTokens,
        outputTokens: totalUsage.outputTokens,
      },
    });

    return {
      content: finalContent,
      tokenUsage: totalUsage,
      model,
      toolCalls: allToolCalls,
      sessionId,
    };
  }

  // ─── Internal Claude API Call ───────────────────────────────────────────

  private async callClaude(
    systemPrompt: string,
    messages: Anthropic.Messages.MessageParam[],
    tools: Anthropic.Messages.Tool[] | undefined,
    onChunk?: StreamChunkCallback
  ): Promise<{
    contentBlocks: Anthropic.Messages.ContentBlock[];
    usage: TokenUsage;
    model: string;
    stopReason: string | null;
  }> {
    const params: Anthropic.Messages.MessageCreateParams = {
      model: this.config.model,
      max_tokens: this.config.maxTokens,
      temperature: this.config.temperature,
      system: systemPrompt,
      messages,
    };

    if (tools && tools.length > 0) {
      params.tools = tools;
    }

    const stream = this.client.messages.stream(params);

    // Stream text chunks for first round
    if (onChunk) {
      stream.on("text", (text) => onChunk(text));
    }

    const finalMessage = await stream.finalMessage();

    return {
      contentBlocks: finalMessage.content,
      usage: {
        inputTokens: finalMessage.usage.input_tokens,
        outputTokens: finalMessage.usage.output_tokens,
      },
      model: finalMessage.model,
      stopReason: finalMessage.stop_reason,
    };
  }
}
