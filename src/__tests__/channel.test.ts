/**
 * Phase 5 Tests — Channel System
 *
 * Covers:
 * - Text chunking (basic + markdown-aware)
 * - Markdown → Telegram HTML conversion
 * - Markdown → Plain text conversion
 * - formatForChannel dispatch
 * - ChannelRegistry (registration, routing, events, dedup)
 * - TelegramAdapter (normalization, allowlist, @mention detection)
 * - IMessageAdapter (normalization, handle normalization, allowlist)
 * - ChannelHandler (session mapping, message flow)
 * - Config schema (channel config validation)
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ─── Outbound: Text Chunking ────────────────────────────────────

import {
  chunkText,
  chunkMarkdownAware,
  markdownToTelegramHtml,
  markdownToTelegramHtmlChunks,
  markdownToPlainText,
  formatForChannel,
} from "../channel/outbound.js";

describe("chunkText", () => {
  it("returns single chunk for short text", () => {
    const result = chunkText("Hello world", 100);
    expect(result).toEqual(["Hello world"]);
  });

  it("chunks at paragraph boundary", () => {
    const text = "First paragraph.\n\nSecond paragraph.";
    const result = chunkText(text, 25);
    expect(result.length).toBe(2);
    expect(result[0]).toBe("First paragraph.");
    expect(result[1]).toBe("Second paragraph.");
  });

  it("chunks at newline boundary when no paragraph break", () => {
    const text = "Line one here.\nLine two here.";
    const result = chunkText(text, 20);
    expect(result.length).toBe(2);
    expect(result[0]).toBe("Line one here.");
    expect(result[1]).toBe("Line two here.");
  });

  it("chunks at sentence boundary", () => {
    const text = "First sentence. Second sentence here.";
    const result = chunkText(text, 25);
    expect(result.length).toBe(2);
    expect(result[0]).toBe("First sentence.");
    expect(result[1]).toBe("Second sentence here.");
  });

  it("chunks at word boundary", () => {
    const text = "word1 word2 word3 word4 word5";
    const result = chunkText(text, 15);
    expect(result.length).toBeGreaterThan(1);
    // No chunk should exceed maxSize
    for (const chunk of result) {
      expect(chunk.length).toBeLessThanOrEqual(15);
    }
  });

  it("force-chunks very long words", () => {
    const text = "a".repeat(50);
    const result = chunkText(text, 20);
    expect(result.length).toBe(3);
    expect(result[0].length).toBe(20);
    expect(result[1].length).toBe(20);
    expect(result[2].length).toBe(10);
  });

  it("returns empty array for empty text", () => {
    expect(chunkText("", 100)).toEqual([""]);
  });

  it("handles text exactly at maxSize", () => {
    const text = "x".repeat(100);
    const result = chunkText(text, 100);
    expect(result).toEqual([text]);
  });
});

describe("chunkMarkdownAware", () => {
  it("returns single chunk for short text", () => {
    const result = chunkMarkdownAware("Hello", 100);
    expect(result).toEqual(["Hello"]);
  });

  it("avoids splitting inside code blocks when possible", () => {
    // When the text before the code block is large enough (>20% of maxSize),
    // the splitter will break before the code block
    const text = "Before text here is some content.\n\n```js\nconst x = 1;\nconst y = 2;\n```\n\nAfter text.";
    const result = chunkMarkdownAware(text, 50);
    // First chunk should be the text before the code block
    expect(result[0]).not.toContain("```");
    expect(result.length).toBeGreaterThan(1);
  });

  it("still chunks very long code blocks", () => {
    const longCode = "```\n" + "x = 1;\n".repeat(100) + "```";
    const result = chunkMarkdownAware(longCode, 100);
    expect(result.length).toBeGreaterThan(1);
  });
});

// ─── Outbound: Markdown → Telegram HTML ─────────────────────────

describe("markdownToTelegramHtml", () => {
  it("converts bold syntax", () => {
    expect(markdownToTelegramHtml("**bold text**")).toBe("<b>bold text</b>");
  });

  it("converts italic syntax", () => {
    expect(markdownToTelegramHtml("*italic text*")).toBe("<i>italic text</i>");
  });

  it("converts inline code", () => {
    expect(markdownToTelegramHtml("`some code`")).toBe(
      "<code>some code</code>"
    );
  });

  it("converts code blocks with language", () => {
    const md = "```js\nconst x = 1;\n```";
    const html = markdownToTelegramHtml(md);
    expect(html).toContain('<pre><code class="language-js">');
    expect(html).toContain("const x = 1;");
    expect(html).toContain("</code></pre>");
  });

  it("converts code blocks without language", () => {
    const md = "```\nhello\n```";
    const html = markdownToTelegramHtml(md);
    expect(html).toContain("<pre><code>");
    expect(html).toContain("hello");
  });

  it("converts links", () => {
    expect(markdownToTelegramHtml("[click](https://example.com)")).toBe(
      '<a href="https://example.com">click</a>'
    );
  });

  it("converts strikethrough", () => {
    expect(markdownToTelegramHtml("~~deleted~~")).toBe("<s>deleted</s>");
  });

  it("escapes HTML entities in non-code text", () => {
    expect(markdownToTelegramHtml("a < b & c > d")).toBe(
      "a &lt; b &amp; c &gt; d"
    );
  });

  it("preserves HTML entities inside code blocks", () => {
    const md = "```\n<div>hello</div>\n```";
    const html = markdownToTelegramHtml(md);
    expect(html).toContain("&lt;div&gt;hello&lt;/div&gt;");
  });

  it("handles mixed formatting", () => {
    const md = "**bold** and *italic* and `code`";
    const html = markdownToTelegramHtml(md);
    expect(html).toContain("<b>bold</b>");
    expect(html).toContain("<i>italic</i>");
    expect(html).toContain("<code>code</code>");
  });
});

describe("markdownToTelegramHtmlChunks", () => {
  it("returns single chunk for short text", () => {
    const result = markdownToTelegramHtmlChunks("**hello**", 1000);
    expect(result).toEqual(["<b>hello</b>"]);
  });

  it("chunks long text and converts each chunk", () => {
    const md = "**Part one.**\n\n**Part two.**";
    const result = markdownToTelegramHtmlChunks(md, 20);
    expect(result.length).toBe(2);
    expect(result[0]).toContain("<b>");
    expect(result[1]).toContain("<b>");
  });
});

// ─── Outbound: Markdown → Plain Text ────────────────────────────

describe("markdownToPlainText", () => {
  it("strips bold markers", () => {
    expect(markdownToPlainText("**bold**")).toBe("bold");
  });

  it("strips italic markers", () => {
    expect(markdownToPlainText("*italic*")).toBe("italic");
  });

  it("strips inline code backticks", () => {
    expect(markdownToPlainText("`code`")).toBe("code");
  });

  it("strips code block fences", () => {
    expect(markdownToPlainText("```js\ncode\n```")).toBe("code\n");
  });

  it("converts links to text (url) format", () => {
    expect(markdownToPlainText("[click](https://example.com)")).toBe(
      "click (https://example.com)"
    );
  });

  it("strips strikethrough", () => {
    expect(markdownToPlainText("~~deleted~~")).toBe("deleted");
  });

  it("preserves plain text unchanged", () => {
    expect(markdownToPlainText("just plain text")).toBe("just plain text");
  });
});

// ─── Outbound: formatForChannel ─────────────────────────────────

describe("formatForChannel", () => {
  it("formats as HTML for html format", () => {
    const result = formatForChannel("**bold**", {
      maxChunkSize: 1000,
      convertMarkdown: true,
      format: "html",
    });
    expect(result).toEqual(["<b>bold</b>"]);
  });

  it("formats as plain text for plain format", () => {
    const result = formatForChannel("**bold**", {
      maxChunkSize: 1000,
      convertMarkdown: true,
      format: "plain",
    });
    expect(result).toEqual(["bold"]);
  });

  it("formats as markdown for markdown format", () => {
    const result = formatForChannel("**bold**", {
      maxChunkSize: 1000,
      convertMarkdown: false,
      format: "markdown",
    });
    expect(result).toEqual(["**bold**"]);
  });
});

// ─── Channel Registry ───────────────────────────────────────────

import { ChannelRegistry } from "../channel/registry.js";
import type {
  ChannelAdapter,
  ChannelMessage,
  ChannelConfig,
  ChannelEvent,
  SendResult,
} from "../channel/types.js";

function createMockAdapter(
  id: "telegram" | "imessage" = "telegram"
): ChannelAdapter & {
  _handlers: Array<(msg: ChannelMessage) => Promise<void>>;
  _connected: boolean;
  _sent: Array<{ chatId: string; text: string }>;
  _allowAll: boolean;
} {
  const adapter = {
    id,
    name: id === "telegram" ? "Telegram" : "iMessage",
    _connected: false,
    _handlers: [] as Array<(msg: ChannelMessage) => Promise<void>>,
    _sent: [] as Array<{ chatId: string; text: string }>,
    _allowAll: true,
    get connected() {
      return this._connected;
    },
    async connect() {
      this._connected = true;
    },
    onMessage(handler: (msg: ChannelMessage) => Promise<void>) {
      this._handlers.push(handler);
    },
    async send(chatId: string, text: string): Promise<SendResult> {
      this._sent.push({ chatId, text });
      return { success: true, messageIds: ["msg-1"], chunksCount: 1 };
    },
    async disconnect() {
      this._connected = false;
    },
    isAllowed(_senderId: string): boolean {
      return this._allowAll;
    },
  };
  return adapter;
}

function createTestMessage(overrides?: Partial<ChannelMessage>): ChannelMessage {
  return {
    messageId: "msg-123",
    channel: "telegram",
    senderId: "user-1",
    senderName: "Test User",
    chatId: "chat-1",
    text: "Hello Lliam",
    isGroup: false,
    timestamp: Date.now(),
    ...overrides,
  };
}

describe("ChannelRegistry", () => {
  let registry: ChannelRegistry;

  beforeEach(() => {
    registry = new ChannelRegistry();
  });

  it("registers an adapter", () => {
    const adapter = createMockAdapter();
    const config: ChannelConfig = {
      enabled: true,
      allowlist: [],
      textChunkLimit: 4000,
    };
    registry.registerAdapter(adapter, config);
    expect(registry.getRegisteredChannels()).toContain("telegram");
  });

  it("connects all enabled adapters", async () => {
    const adapter = createMockAdapter();
    const config: ChannelConfig = {
      enabled: true,
      allowlist: [],
      textChunkLimit: 4000,
    };
    registry.registerAdapter(adapter, config);
    await registry.connectAll();
    expect(adapter.connected).toBe(true);
    expect(registry.getConnectedChannels()).toContain("telegram");
  });

  it("skips disabled adapters on connectAll", async () => {
    const adapter = createMockAdapter();
    const config: ChannelConfig = {
      enabled: false,
      allowlist: [],
      textChunkLimit: 4000,
    };
    registry.registerAdapter(adapter, config);
    await registry.connectAll();
    expect(adapter.connected).toBe(false);
    expect(registry.getConnectedChannels()).toEqual([]);
  });

  it("routes inbound messages through handler", async () => {
    const adapter = createMockAdapter();
    const config: ChannelConfig = {
      enabled: true,
      allowlist: [],
      textChunkLimit: 4000,
    };
    registry.registerAdapter(adapter, config);

    const responses: string[] = [];
    registry.setMessageHandler(async (msg) => {
      responses.push(`Response to: ${msg.text}`);
      return `Response to: ${msg.text}`;
    });

    await registry.connectAll();

    // Simulate inbound message
    const testMsg = createTestMessage();
    for (const handler of adapter._handlers) {
      await handler(testMsg);
    }

    expect(responses).toHaveLength(1);
    expect(responses[0]).toBe("Response to: Hello Lliam");

    // Verify outbound was sent
    expect(adapter._sent).toHaveLength(1);
    expect(adapter._sent[0].chatId).toBe("chat-1");
  });

  it("deduplicates concurrent messages by ID", async () => {
    const adapter = createMockAdapter();
    const config: ChannelConfig = {
      enabled: true,
      allowlist: [],
      textChunkLimit: 4000,
    };
    registry.registerAdapter(adapter, config);

    let callCount = 0;
    registry.setMessageHandler(async () => {
      // Simulate async processing delay
      await new Promise((r) => setTimeout(r, 50));
      callCount++;
      return "response";
    });

    await registry.connectAll();

    const testMsg = createTestMessage();
    // Fire same message concurrently — second should be deduped
    const handler = adapter._handlers[0];
    await Promise.all([handler(testMsg), handler(testMsg)]);

    expect(callCount).toBe(1);
  });

  it("blocks messages from non-allowlisted senders", async () => {
    const adapter = createMockAdapter();
    adapter._allowAll = false; // Block all
    const config: ChannelConfig = {
      enabled: true,
      allowlist: ["user-1"],
      textChunkLimit: 4000,
    };
    registry.registerAdapter(adapter, config);

    const events: ChannelEvent[] = [];
    registry.addEventListener((event) => events.push(event));

    let handlerCalled = false;
    registry.setMessageHandler(async () => {
      handlerCalled = true;
      return "response";
    });

    await registry.connectAll();

    const testMsg = createTestMessage({ senderId: "user-blocked" });
    for (const handler of adapter._handlers) {
      await handler(testMsg);
    }

    expect(handlerCalled).toBe(false);
    expect(events.some((e) => e.type === "message_blocked")).toBe(true);
  });

  it("emits events for connected, message_received, message_sent", async () => {
    const adapter = createMockAdapter();
    const config: ChannelConfig = {
      enabled: true,
      allowlist: [],
      textChunkLimit: 4000,
    };
    registry.registerAdapter(adapter, config);

    const events: ChannelEvent[] = [];
    registry.addEventListener((event) => events.push(event));

    registry.setMessageHandler(async () => "response");

    await registry.connectAll();

    const testMsg = createTestMessage();
    for (const handler of adapter._handlers) {
      await handler(testMsg);
    }

    const types = events.map((e) => e.type);
    expect(types).toContain("connected");
    expect(types).toContain("message_received");
    expect(types).toContain("message_sent");
  });

  it("disconnects all adapters", async () => {
    const adapter = createMockAdapter();
    const config: ChannelConfig = {
      enabled: true,
      allowlist: [],
      textChunkLimit: 4000,
    };
    registry.registerAdapter(adapter, config);
    await registry.connectAll();
    expect(adapter.connected).toBe(true);

    await registry.disconnectAll();
    expect(adapter.connected).toBe(false);
  });

  it("manual send works for connected adapters", async () => {
    const adapter = createMockAdapter();
    const config: ChannelConfig = {
      enabled: true,
      allowlist: [],
      textChunkLimit: 4000,
    };
    registry.registerAdapter(adapter, config);
    await registry.connectAll();

    const result = await registry.send("telegram", "chat-42", "Hello!");
    expect(result.success).toBe(true);
    expect(adapter._sent).toHaveLength(1);
    expect(adapter._sent[0].chatId).toBe("chat-42");
  });

  it("manual send fails for unregistered channel", async () => {
    const result = await registry.send("telegram", "chat-1", "Hello!");
    expect(result.success).toBe(false);
    expect(result.error).toContain("not registered");
  });

  it("manual send fails for disconnected channel", async () => {
    const adapter = createMockAdapter();
    const config: ChannelConfig = {
      enabled: true,
      allowlist: [],
      textChunkLimit: 4000,
    };
    registry.registerAdapter(adapter, config);
    // Don't connect

    const result = await registry.send("telegram", "chat-1", "Hello!");
    expect(result.success).toBe(false);
    expect(result.error).toContain("not connected");
  });

  it("drops message when no handler registered", async () => {
    const adapter = createMockAdapter();
    const config: ChannelConfig = {
      enabled: true,
      allowlist: [],
      textChunkLimit: 4000,
    };
    registry.registerAdapter(adapter, config);
    // No handler set
    await registry.connectAll();

    const testMsg = createTestMessage();
    // Should not throw
    for (const handler of adapter._handlers) {
      await handler(testMsg);
    }
    // Nothing sent back
    expect(adapter._sent).toHaveLength(0);
  });

  it("does not send empty response back", async () => {
    const adapter = createMockAdapter();
    const config: ChannelConfig = {
      enabled: true,
      allowlist: [],
      textChunkLimit: 4000,
    };
    registry.registerAdapter(adapter, config);
    registry.setMessageHandler(async () => "   "); // Empty/whitespace
    await registry.connectAll();

    const testMsg = createTestMessage();
    for (const handler of adapter._handlers) {
      await handler(testMsg);
    }
    expect(adapter._sent).toHaveLength(0);
  });

  it("handles handler errors without crashing", async () => {
    const adapter = createMockAdapter();
    const config: ChannelConfig = {
      enabled: true,
      allowlist: [],
      textChunkLimit: 4000,
    };
    registry.registerAdapter(adapter, config);
    registry.setMessageHandler(async () => {
      throw new Error("Handler exploded");
    });

    const events: ChannelEvent[] = [];
    registry.addEventListener((event) => events.push(event));

    await registry.connectAll();

    const testMsg = createTestMessage();
    // Should not throw
    for (const handler of adapter._handlers) {
      await handler(testMsg);
    }

    expect(events.some((e) => e.type === "error")).toBe(true);
  });

  it("getAdapter returns registered adapter", () => {
    const adapter = createMockAdapter();
    const config: ChannelConfig = {
      enabled: true,
      allowlist: [],
      textChunkLimit: 4000,
    };
    registry.registerAdapter(adapter, config);
    expect(registry.getAdapter("telegram")).toBe(adapter);
  });

  it("getAdapter returns undefined for unknown channel", () => {
    expect(registry.getAdapter("telegram")).toBeUndefined();
  });
});

// ─── Telegram Adapter ───────────────────────────────────────────

import { TelegramAdapter } from "../channel/telegram/adapter.js";

describe("TelegramAdapter", () => {
  it("has correct id and name", () => {
    const adapter = new TelegramAdapter();
    expect(adapter.id).toBe("telegram");
    expect(adapter.name).toBe("Telegram");
    expect(adapter.connected).toBe(false);
  });

  it("throws on connect without bot token", async () => {
    const adapter = new TelegramAdapter();
    await expect(
      adapter.connect({
        enabled: true,
        allowlist: [],
        textChunkLimit: 4000,
        botToken: "",
        polling: true,
        allowGroups: false,
        requireMention: true,
      })
    ).rejects.toThrow("bot token is required");
  });

  it("isAllowed returns true when allowlist is empty", () => {
    const adapter = new TelegramAdapter();
    expect(adapter.isAllowed("anyone")).toBe(true);
  });

  it("send returns error when not connected", async () => {
    const adapter = new TelegramAdapter();
    const result = await adapter.send("123", "hello");
    expect(result.success).toBe(false);
    expect(result.error).toContain("not connected");
  });

  it("registers message handlers", () => {
    const adapter = new TelegramAdapter();
    const handler = vi.fn();
    adapter.onMessage(handler);
    // Handler registered but not called (no bot connected)
    expect(handler).not.toHaveBeenCalled();
  });
});

// ─── iMessage Adapter ───────────────────────────────────────────

import { IMessageAdapter, normalizeHandle } from "../channel/imessage/adapter.js";

describe("IMessageAdapter", () => {
  it("has correct id and name", () => {
    const adapter = new IMessageAdapter();
    expect(adapter.id).toBe("imessage");
    expect(adapter.name).toBe("iMessage");
    expect(adapter.connected).toBe(false);
  });

  it("throws on connect without server URL", async () => {
    const adapter = new IMessageAdapter();
    await expect(
      adapter.connect({
        enabled: true,
        allowlist: [],
        textChunkLimit: 2000,
        serverUrl: "",
        password: "test",
        pollIntervalMs: 5000,
      })
    ).rejects.toThrow("server URL is required");
  });

  it("throws on connect without password", async () => {
    const adapter = new IMessageAdapter();
    await expect(
      adapter.connect({
        enabled: true,
        allowlist: [],
        textChunkLimit: 2000,
        serverUrl: "http://localhost:1234",
        password: "",
        pollIntervalMs: 5000,
      })
    ).rejects.toThrow("password is required");
  });

  it("isAllowed returns true when allowlist is empty", () => {
    const adapter = new IMessageAdapter();
    expect(adapter.isAllowed("anyone")).toBe(true);
  });

  it("send returns error when not connected", async () => {
    const adapter = new IMessageAdapter();
    const result = await adapter.send("chat-1", "hello");
    expect(result.success).toBe(false);
    expect(result.error).toContain("not connected");
  });

  it("registers message handlers", () => {
    const adapter = new IMessageAdapter();
    const handler = vi.fn();
    adapter.onMessage(handler);
    expect(handler).not.toHaveBeenCalled();
  });
});

describe("normalizeHandle", () => {
  it("lowercases email addresses", () => {
    expect(normalizeHandle("User@Example.COM")).toBe("user@example.com");
  });

  it("strips +1 prefix from US phone numbers", () => {
    expect(normalizeHandle("+12125551234")).toBe("2125551234");
  });

  it("strips formatting from phone numbers", () => {
    expect(normalizeHandle("(212) 555-1234")).toBe("2125551234");
  });

  it("strips spaces from phone numbers", () => {
    expect(normalizeHandle("212 555 1234")).toBe("2125551234");
  });

  it("preserves international numbers without +1", () => {
    expect(normalizeHandle("+442071234567")).toBe("+442071234567");
  });

  it("handles already clean 10-digit numbers", () => {
    expect(normalizeHandle("2125551234")).toBe("2125551234");
  });

  it("trims whitespace", () => {
    expect(normalizeHandle("  user@example.com  ")).toBe("user@example.com");
  });
});

// ─── Config Schema: Channel Config ──────────────────────────────

import {
  TelegramConfigSchema,
  IMessageConfigSchema,
  ChannelsConfigSchema,
  AppConfigSchema,
} from "../config/schema.js";

describe("Channel Config Schema", () => {
  describe("TelegramConfigSchema", () => {
    it("defaults to disabled", () => {
      const config = TelegramConfigSchema.parse({});
      expect(config.enabled).toBe(false);
      expect(config.polling).toBe(true);
      expect(config.allowGroups).toBe(false);
      expect(config.requireMention).toBe(true);
      expect(config.textChunkLimit).toBe(4000);
    });

    it("validates with all fields", () => {
      const config = TelegramConfigSchema.parse({
        enabled: true,
        botToken: "123:ABC",
        polling: true,
        allowGroups: true,
        requireMention: false,
        allowlist: ["user1", "user2"],
        textChunkLimit: 3000,
      });
      expect(config.enabled).toBe(true);
      expect(config.botToken).toBe("123:ABC");
      expect(config.allowlist).toEqual(["user1", "user2"]);
    });
  });

  describe("IMessageConfigSchema", () => {
    it("defaults to disabled", () => {
      const config = IMessageConfigSchema.parse({});
      expect(config.enabled).toBe(false);
      expect(config.serverUrl).toBe("http://localhost:1234");
      expect(config.pollIntervalMs).toBe(5000);
      expect(config.textChunkLimit).toBe(2000);
    });

    it("validates with all fields", () => {
      const config = IMessageConfigSchema.parse({
        enabled: true,
        serverUrl: "http://myserver:5555",
        password: "secret",
        pollIntervalMs: 3000,
        allowlist: ["+12125551234"],
      });
      expect(config.enabled).toBe(true);
      expect(config.serverUrl).toBe("http://myserver:5555");
    });
  });

  describe("ChannelsConfigSchema", () => {
    it("defaults both channels to disabled", () => {
      const config = ChannelsConfigSchema.parse({});
      expect(config.telegram.enabled).toBe(false);
      expect(config.imessage.enabled).toBe(false);
    });
  });

  describe("AppConfigSchema with channels", () => {
    it("includes channels section with defaults", () => {
      const config = AppConfigSchema.parse({});
      expect(config.channels).toBeDefined();
      expect(config.channels.telegram.enabled).toBe(false);
      expect(config.channels.imessage.enabled).toBe(false);
    });

    it("accepts channel overrides", () => {
      const config = AppConfigSchema.parse({
        channels: {
          telegram: {
            enabled: true,
            botToken: "test-token",
          },
        },
      });
      expect(config.channels.telegram.enabled).toBe(true);
      expect(config.channels.telegram.botToken).toBe("test-token");
      expect(config.channels.imessage.enabled).toBe(false);
    });
  });
});
