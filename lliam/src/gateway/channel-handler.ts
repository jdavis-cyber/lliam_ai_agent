/**
 * Channel Handler — Integrates channel adapters into the gateway message flow.
 *
 * Connects the ChannelRegistry to the existing Agent and SessionManager,
 * so inbound messages from Telegram/iMessage flow through the same
 * agent pipeline as WebSocket messages.
 */

import { Agent } from "../core/agent.js";
import type { SessionManager } from "../session/manager.js";
import type { AgentConfig } from "../types/index.js";
import { ChannelRegistry, type ChannelEventListener } from "../channel/registry.js";
import { TelegramAdapter } from "../channel/telegram/adapter.js";
import { IMessageAdapter } from "../channel/imessage/adapter.js";
import type {
  ChannelMessage,
  TelegramChannelConfig,
  IMessageChannelConfig,
  ChannelEvent,
} from "../channel/types.js";

// ─── Channel Session Mapping ────────────────────────────────────

/**
 * Maps channel:chatId pairs to session IDs.
 * Ensures continuity — the same Telegram chat always maps to the same session.
 */
class ChannelSessionMap {
  private map = new Map<string, string>();

  getKey(channel: string, chatId: string): string {
    return `${channel}:${chatId}`;
  }

  getSessionId(channel: string, chatId: string): string | undefined {
    return this.map.get(this.getKey(channel, chatId));
  }

  setSessionId(channel: string, chatId: string, sessionId: string): void {
    this.map.set(this.getKey(channel, chatId), sessionId);
  }
}

// ─── Channel Handler Config ─────────────────────────────────────

export interface ChannelHandlerConfig {
  sessionManager: SessionManager;
  agentConfig: AgentConfig;
  telegram?: TelegramChannelConfig;
  imessage?: IMessageChannelConfig;
}

// ─── Channel Handler ────────────────────────────────────────────

export class ChannelHandler {
  private registry: ChannelRegistry;
  private sessionManager: SessionManager;
  private agentConfig: AgentConfig;
  private sessionMap = new ChannelSessionMap();

  constructor(config: ChannelHandlerConfig) {
    this.registry = new ChannelRegistry();
    this.sessionManager = config.sessionManager;
    this.agentConfig = config.agentConfig;

    // Register adapters based on config
    if (config.telegram && config.telegram.enabled) {
      this.registry.registerAdapter(new TelegramAdapter(), config.telegram);
    }

    if (config.imessage && config.imessage.enabled) {
      this.registry.registerAdapter(new IMessageAdapter(), config.imessage);
    }

    // Wire message handler: inbound → agent → outbound
    this.registry.setMessageHandler((msg) => this.processMessage(msg));

    // Wire default event logging
    this.registry.addEventListener((event) => this.logEvent(event));
  }

  /**
   * Connect all registered and enabled channel adapters.
   */
  async connectAll(): Promise<void> {
    await this.registry.connectAll();
    const connected = this.registry.getConnectedChannels();
    if (connected.length > 0) {
      console.log(`  Channels connected: ${connected.join(", ")}`);
    }
  }

  /**
   * Disconnect all channel adapters.
   */
  async disconnectAll(): Promise<void> {
    await this.registry.disconnectAll();
  }

  /**
   * Add an event listener for channel events.
   */
  addEventListener(listener: ChannelEventListener): void {
    this.registry.addEventListener(listener);
  }

  /**
   * Get the underlying registry for direct access.
   */
  getRegistry(): ChannelRegistry {
    return this.registry;
  }

  /**
   * Get connected channel IDs.
   */
  getConnectedChannels(): string[] {
    return this.registry.getConnectedChannels();
  }

  // ─── Message Processing ───────────────────────────────────────

  /**
   * Process an inbound channel message through the agent pipeline.
   *
   * Flow:
   * 1. Resolve or create session for this channel:chatId
   * 2. Add user message to session history
   * 3. Create agent with conversation history
   * 4. Execute agent and collect response
   * 5. Save assistant message to session
   * 6. Return response text for outbound delivery
   */
  private async processMessage(message: ChannelMessage): Promise<string> {
    // 1. Resolve session
    let sessionId = this.sessionMap.getSessionId(
      message.channel,
      message.chatId
    );

    if (!sessionId || !this.sessionManager.sessionExists(sessionId)) {
      const channelLabel = message.channel === "telegram" ? "Telegram" : "iMessage";
      const session = this.sessionManager.createSession(
        `${channelLabel} — ${message.senderName}`
      );
      sessionId = session.sessionId;
      this.sessionMap.setSessionId(message.channel, message.chatId, sessionId);
    }

    // 2. Add user message to session
    await this.sessionManager.addMessage(sessionId, {
      role: "user",
      content: message.text,
      timestamp: message.timestamp,
      metadata: {
        channel: message.channel,
        senderId: message.senderId,
        senderName: message.senderName,
        chatId: message.chatId,
        messageId: message.messageId,
      },
    });

    // 3. Create agent with history
    const agent = new Agent(this.agentConfig);
    const history = this.sessionManager.getHistory(sessionId);

    // Load history (skip last since we'll send it fresh)
    for (const msg of history.slice(0, -1)) {
      if (msg.role === "user" || msg.role === "assistant") {
        agent["conversationHistory"].push(msg);
      }
    }

    // 4. Execute agent (no streaming for channel messages)
    const response = await agent.executeMessage(message.text);

    // 5. Save assistant message
    await this.sessionManager.addMessage(sessionId, {
      role: "assistant",
      content: response.content,
      timestamp: Date.now(),
      metadata: {
        model: response.model,
        tokenUsage: response.tokenUsage,
        channel: message.channel,
      },
    });

    // 6. Return response text
    return response.content;
  }

  // ─── Event Logging ────────────────────────────────────────────

  private logEvent(event: ChannelEvent): void {
    switch (event.type) {
      case "connected":
        console.log(`  [channel:${event.channel}] Connected`);
        break;
      case "disconnected":
        console.log(`  [channel:${event.channel}] Disconnected: ${event.reason || "unknown"}`);
        break;
      case "message_received":
        console.log(
          `  [channel:${event.channel}] Message from ${event.message.senderName} (${event.message.senderId})`
        );
        break;
      case "message_sent":
        console.log(
          `  [channel:${event.channel}] Sent ${event.chunksCount} chunk(s) to ${event.chatId}`
        );
        break;
      case "message_blocked":
        console.log(
          `  [channel:${event.channel}] Blocked ${event.senderId}: ${event.reason}`
        );
        break;
      case "error":
        console.error(`  [channel:${event.channel}] Error: ${event.error.message}`);
        break;
    }
  }
}
