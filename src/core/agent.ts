import Anthropic from "@anthropic-ai/sdk";
import type {
  AgentConfig,
  AgentResponse,
  Message,
  StreamChunkCallback,
  TokenUsage,
  ToolCall,
} from "../types/index.js";

const DEFAULT_SYSTEM_PROMPT = `You are Lliam, a personal AI assistant built for a senior Program Manager and AI Governance Strategist. You are structured, precise, and operate as a strategic partner — not a generic assistant.

Core traits:
- Start with key takeaways, then provide detail
- Use structured formats (tables, matrices, bullet points) when appropriate
- Prioritize clarity, logic, and decision-usefulness over verbosity
- Maintain a peer-to-peer, professional tone
- When asked about governance, compliance, or risk — provide depth

You are running locally on the user's machine. All data stays local. You have no access to external systems unless explicitly connected via plugins.`;

/**
 * Core Agent class — interfaces with Anthropic Claude API.
 * Handles streaming responses, conversation history, retry logic.
 */
export class Agent {
  private client: Anthropic;
  private config: AgentConfig;
  private conversationHistory: Message[];

  constructor(config: AgentConfig, apiKey?: string) {
    const key = apiKey ?? process.env.ANTHROPIC_API_KEY;
    if (!key) {
      throw new Error(
        "ANTHROPIC_API_KEY is required. Set it in your environment or .env file."
      );
    }

    this.client = new Anthropic({ apiKey: key });
    this.config = config;
    this.conversationHistory = [];
  }

  /**
   * Send a message to Claude and get a streaming response.
   * @param userMessage - The user's input text
   * @param onChunk - Optional callback for each streaming text chunk
   * @returns Full agent response with metadata
   */
  async executeMessage(
    userMessage: string,
    onChunk?: StreamChunkCallback
  ): Promise<AgentResponse> {
    // Validate input
    if (!userMessage.trim()) {
      throw new Error("Message cannot be empty.");
    }

    if (userMessage.length > 100_000) {
      throw new Error("Message exceeds maximum length of 100,000 characters.");
    }

    // Add user message to history
    this.conversationHistory.push({
      role: "user",
      content: userMessage,
      timestamp: Date.now(),
    });

    // Build messages array for API (only user/assistant roles)
    const apiMessages = this.conversationHistory.map((msg) => ({
      role: msg.role as "user" | "assistant",
      content: msg.content,
    }));

    // Execute with retry logic
    const response = await this.executeWithRetry(apiMessages, onChunk);

    // Add assistant response to history
    this.conversationHistory.push({
      role: "assistant",
      content: response.content,
      timestamp: Date.now(),
      metadata: {
        model: response.model,
        tokenUsage: response.tokenUsage,
        toolCalls: response.toolCalls,
      },
    });

    return response;
  }

  /**
   * Execute API call with exponential backoff retry.
   */
  private async executeWithRetry(
    messages: Array<{ role: "user" | "assistant"; content: string }>,
    onChunk?: StreamChunkCallback
  ): Promise<AgentResponse> {
    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= this.config.maxRetries; attempt++) {
      try {
        return await this.streamMessage(messages, onChunk);
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));

        // Only retry on transient errors (429, 500, 529)
        if (!this.isRetryableError(error)) {
          throw lastError;
        }

        if (attempt < this.config.maxRetries) {
          const delay = this.config.retryDelayMs * Math.pow(2, attempt);
          await this.sleep(delay);
        }
      }
    }

    throw lastError ?? new Error("All retry attempts failed.");
  }

  /**
   * Stream a message from the Anthropic API.
   */
  private async streamMessage(
    messages: Array<{ role: "user" | "assistant"; content: string }>,
    onChunk?: StreamChunkCallback
  ): Promise<AgentResponse> {
    const systemPrompt =
      this.config.systemPrompt ?? DEFAULT_SYSTEM_PROMPT;

    const stream = this.client.messages.stream({
      model: this.config.model,
      max_tokens: this.config.maxTokens,
      temperature: this.config.temperature,
      system: systemPrompt,
      messages,
    });

    let fullContent = "";
    const toolCalls: ToolCall[] = [];
    let tokenUsage: TokenUsage = { inputTokens: 0, outputTokens: 0 };
    let stopReason: string | null = null;
    let model = this.config.model;

    // Handle streaming events
    stream.on("text", (text) => {
      fullContent += text;
      if (onChunk) {
        onChunk(text);
      }
    });

    // Await the final message
    const finalMessage = await stream.finalMessage();

    // Extract metadata from final message
    tokenUsage = {
      inputTokens: finalMessage.usage.input_tokens,
      outputTokens: finalMessage.usage.output_tokens,
    };
    stopReason = finalMessage.stop_reason;
    model = finalMessage.model;

    // Extract full text content if streaming missed anything
    if (!fullContent) {
      for (const block of finalMessage.content) {
        if (block.type === "text") {
          fullContent += block.text;
        }
      }
    }

    return {
      content: fullContent,
      tokenUsage,
      model,
      stopReason,
      toolCalls,
    };
  }

  /**
   * Check if an error is retryable (transient server/rate limit errors).
   */
  private isRetryableError(error: unknown): boolean {
    if (error instanceof Anthropic.APIError) {
      return [429, 500, 502, 503, 529].includes(error.status);
    }

    // Network errors are retryable
    if (error instanceof Error) {
      const msg = error.message.toLowerCase();
      return (
        msg.includes("econnreset") ||
        msg.includes("econnrefused") ||
        msg.includes("timeout") ||
        msg.includes("network")
      );
    }

    return false;
  }

  /**
   * Get the current conversation history.
   */
  getHistory(): ReadonlyArray<Message> {
    return [...this.conversationHistory];
  }

  /**
   * Clear conversation history (start a new session).
   */
  clearHistory(): void {
    this.conversationHistory = [];
  }

  /**
   * Get the current agent configuration.
   */
  getConfig(): Readonly<AgentConfig> {
    return { ...this.config };
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
