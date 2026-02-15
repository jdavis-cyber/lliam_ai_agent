import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Agent } from "../core/agent.js";
import { AgentConfigSchema } from "../types/index.js";
import type { AgentConfig } from "../types/index.js";

// ─── Test Helpers ───────────────────────────────────────────────────────────

const TEST_API_KEY = "sk-ant-test-key-for-unit-tests";

const defaultConfig: AgentConfig = {
  model: "claude-sonnet-4-20250514",
  temperature: 0.7,
  maxTokens: 4096,
  maxRetries: 1,
  retryDelayMs: 100,
};

/**
 * Create a mock stream object that simulates Anthropic's streaming API.
 */
function createMockStream(text: string, options?: {
  inputTokens?: number;
  outputTokens?: number;
  model?: string;
  stopReason?: string;
}) {
  const handlers: Record<string, Array<(...args: unknown[]) => void>> = {};

  const stream = {
    on: (event: string, handler: (...args: unknown[]) => void) => {
      if (!handlers[event]) handlers[event] = [];
      handlers[event].push(handler);
      return stream;
    },
    finalMessage: async () => {
      // Simulate streaming text chunks
      if (handlers["text"]) {
        for (const char of text) {
          for (const handler of handlers["text"]) {
            handler(char);
          }
        }
      }

      return {
        content: [{ type: "text", text }],
        usage: {
          input_tokens: options?.inputTokens ?? 10,
          output_tokens: options?.outputTokens ?? 20,
        },
        model: options?.model ?? "claude-sonnet-4-20250514",
        stop_reason: options?.stopReason ?? "end_turn",
      };
    },
  };

  return stream;
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("Agent", () => {
  let originalEnv: string | undefined;

  beforeEach(() => {
    originalEnv = process.env.ANTHROPIC_API_KEY;
  });

  afterEach(() => {
    if (originalEnv !== undefined) {
      process.env.ANTHROPIC_API_KEY = originalEnv;
    } else {
      delete process.env.ANTHROPIC_API_KEY;
    }
    vi.restoreAllMocks();
  });

  describe("constructor", () => {
    it("should throw if no API key is provided", () => {
      delete process.env.ANTHROPIC_API_KEY;
      expect(() => new Agent(defaultConfig)).toThrow(
        "ANTHROPIC_API_KEY is required"
      );
    });

    it("should accept API key from parameter", () => {
      delete process.env.ANTHROPIC_API_KEY;
      const agent = new Agent(defaultConfig, TEST_API_KEY);
      expect(agent).toBeInstanceOf(Agent);
    });

    it("should accept API key from environment", () => {
      process.env.ANTHROPIC_API_KEY = TEST_API_KEY;
      const agent = new Agent(defaultConfig);
      expect(agent).toBeInstanceOf(Agent);
    });
  });

  describe("executeMessage", () => {
    it("should reject empty messages", async () => {
      const agent = new Agent(defaultConfig, TEST_API_KEY);
      await expect(agent.executeMessage("")).rejects.toThrow(
        "Message cannot be empty"
      );
    });

    it("should reject messages over 100k characters", async () => {
      const agent = new Agent(defaultConfig, TEST_API_KEY);
      const longMessage = "a".repeat(100_001);
      await expect(agent.executeMessage(longMessage)).rejects.toThrow(
        "exceeds maximum length"
      );
    });

    it("should stream response and invoke onChunk callback", async () => {
      const agent = new Agent(defaultConfig, TEST_API_KEY);
      const mockStream = createMockStream("Hello, there!");

      // Mock the Anthropic SDK's stream method
      vi.spyOn(agent["client"].messages, "stream").mockReturnValue(
        mockStream as ReturnType<typeof agent["client"]["messages"]["stream"]>
      );

      const chunks: string[] = [];
      const response = await agent.executeMessage(
        "Hello",
        (chunk: string) => {
          chunks.push(chunk);
        }
      );

      // Verify response content
      expect(response.content).toBe("Hello, there!");
      expect(response.tokenUsage.inputTokens).toBe(10);
      expect(response.tokenUsage.outputTokens).toBe(20);
      expect(response.stopReason).toBe("end_turn");

      // Verify streaming chunks were received
      expect(chunks.length).toBeGreaterThan(0);
      expect(chunks.join("")).toBe("Hello, there!");
    });

    it("should work without onChunk callback", async () => {
      const agent = new Agent(defaultConfig, TEST_API_KEY);
      const mockStream = createMockStream("Response without callback");

      vi.spyOn(agent["client"].messages, "stream").mockReturnValue(
        mockStream as ReturnType<typeof agent["client"]["messages"]["stream"]>
      );

      const response = await agent.executeMessage("Hello");
      expect(response.content).toBe("Response without callback");
    });

    it("should maintain conversation history", async () => {
      const agent = new Agent(defaultConfig, TEST_API_KEY);
      const mockStream = createMockStream("First response");

      vi.spyOn(agent["client"].messages, "stream").mockReturnValue(
        mockStream as ReturnType<typeof agent["client"]["messages"]["stream"]>
      );

      await agent.executeMessage("First message");

      const history = agent.getHistory();
      expect(history).toHaveLength(2);
      expect(history[0].role).toBe("user");
      expect(history[0].content).toBe("First message");
      expect(history[1].role).toBe("assistant");
      expect(history[1].content).toBe("First response");
    });

    it("should pass full conversation history to API", async () => {
      const agent = new Agent(defaultConfig, TEST_API_KEY);

      const streamSpy = vi
        .spyOn(agent["client"].messages, "stream")
        .mockReturnValue(
          createMockStream("Response 1") as ReturnType<typeof agent["client"]["messages"]["stream"]>
        );

      await agent.executeMessage("Message 1");

      streamSpy.mockReturnValue(
        createMockStream("Response 2") as ReturnType<typeof agent["client"]["messages"]["stream"]>
      );

      await agent.executeMessage("Message 2");

      // Second call should include full history
      const secondCallArgs = streamSpy.mock.calls[1][0];
      expect(secondCallArgs.messages).toHaveLength(3); // msg1, resp1, msg2
      expect(secondCallArgs.messages[0].content).toBe("Message 1");
      expect(secondCallArgs.messages[1].content).toBe("Response 1");
      expect(secondCallArgs.messages[2].content).toBe("Message 2");
    });

    it("should include token usage in response metadata", async () => {
      const agent = new Agent(defaultConfig, TEST_API_KEY);
      const mockStream = createMockStream("Test", {
        inputTokens: 42,
        outputTokens: 88,
      });

      vi.spyOn(agent["client"].messages, "stream").mockReturnValue(
        mockStream as ReturnType<typeof agent["client"]["messages"]["stream"]>
      );

      const response = await agent.executeMessage("Test");
      expect(response.tokenUsage).toEqual({
        inputTokens: 42,
        outputTokens: 88,
      });
    });
  });

  describe("clearHistory", () => {
    it("should clear all conversation history", async () => {
      const agent = new Agent(defaultConfig, TEST_API_KEY);
      const mockStream = createMockStream("Response");

      vi.spyOn(agent["client"].messages, "stream").mockReturnValue(
        mockStream as ReturnType<typeof agent["client"]["messages"]["stream"]>
      );

      await agent.executeMessage("Hello");
      expect(agent.getHistory()).toHaveLength(2);

      agent.clearHistory();
      expect(agent.getHistory()).toHaveLength(0);
    });
  });

  describe("getConfig", () => {
    it("should return a copy of the config", () => {
      const agent = new Agent(defaultConfig, TEST_API_KEY);
      const config = agent.getConfig();

      expect(config.model).toBe("claude-sonnet-4-20250514");
      expect(config.temperature).toBe(0.7);
      expect(config.maxTokens).toBe(4096);
    });

    it("should use custom system prompt when provided", async () => {
      const customPrompt = "You are a test assistant.";
      const agent = new Agent(
        { ...defaultConfig, systemPrompt: customPrompt },
        TEST_API_KEY
      );

      const streamSpy = vi
        .spyOn(agent["client"].messages, "stream")
        .mockReturnValue(
          createMockStream("OK") as ReturnType<typeof agent["client"]["messages"]["stream"]>
        );

      await agent.executeMessage("Hello");

      const callArgs = streamSpy.mock.calls[0][0];
      expect(callArgs.system).toBe(customPrompt);
    });
  });

  describe("retry logic", () => {
    it("should not retry on non-retryable errors", async () => {
      const agent = new Agent(
        { ...defaultConfig, maxRetries: 3 },
        TEST_API_KEY
      );

      const streamSpy = vi
        .spyOn(agent["client"].messages, "stream")
        .mockImplementation(() => {
          throw new Error("Invalid API key");
        });

      await expect(agent.executeMessage("Hello")).rejects.toThrow(
        "Invalid API key"
      );

      // Should only have been called once (no retries for non-retryable errors)
      expect(streamSpy).toHaveBeenCalledTimes(1);
    });
  });
});

describe("AgentConfig validation", () => {
  it("should use defaults when no values provided", () => {
    const config = AgentConfigSchema.parse({});

    expect(config.model).toBe("claude-sonnet-4-20250514");
    expect(config.temperature).toBe(0.7);
    expect(config.maxTokens).toBe(4096);
    expect(config.maxRetries).toBe(3);
    expect(config.retryDelayMs).toBe(1000);
  });

  it("should reject invalid temperature", () => {
    expect(() => AgentConfigSchema.parse({ temperature: 1.5 })).toThrow();
  });

  it("should reject negative maxTokens", () => {
    expect(() => AgentConfigSchema.parse({ maxTokens: -1 })).toThrow();
  });
});
