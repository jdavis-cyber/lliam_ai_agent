/**
 * Channel Registry — Register, manage, and route through channel adapters.
 *
 * Coordinates:
 * - Adapter lifecycle (connect/disconnect)
 * - Message routing: inbound → agent → outbound
 * - Contact allowlist enforcement
 * - Event emission for monitoring
 */

import type {
  ChannelAdapter,
  ChannelConfig,
  ChannelEvent,
  ChannelId,
  ChannelMessage,
  SendResult,
} from "./types.js";

/**
 * Handler function for processing inbound messages.
 * Returns the response text to send back.
 */
export type MessageHandler = (
  message: ChannelMessage,
) => Promise<string>;

/**
 * Event listener for channel events.
 */
export type ChannelEventListener = (event: ChannelEvent) => void;

export class ChannelRegistry {
  private adapters = new Map<ChannelId, ChannelAdapter>();
  private configs = new Map<ChannelId, ChannelConfig>();
  private messageHandler: MessageHandler | null = null;
  private eventListeners: ChannelEventListener[] = [];
  private processing = new Set<string>(); // Track in-flight message IDs

  // ─── Registration ──────────────────────────────────────────────

  /**
   * Register a channel adapter with its configuration.
   */
  registerAdapter(adapter: ChannelAdapter, config: ChannelConfig): void {
    this.adapters.set(adapter.id, adapter);
    this.configs.set(adapter.id, config);
  }

  /**
   * Set the handler that processes inbound messages and returns response text.
   */
  setMessageHandler(handler: MessageHandler): void {
    this.messageHandler = handler;
  }

  /**
   * Add an event listener for channel events.
   */
  addEventListener(listener: ChannelEventListener): void {
    this.eventListeners.push(listener);
  }

  // ─── Lifecycle ─────────────────────────────────────────────────

  /**
   * Connect all registered and enabled adapters.
   */
  async connectAll(): Promise<void> {
    const promises: Promise<void>[] = [];

    for (const [channelId, adapter] of this.adapters) {
      const config = this.configs.get(channelId);
      if (!config || !config.enabled) continue;

      promises.push(this.connectAdapter(adapter, config));
    }

    await Promise.allSettled(promises);
  }

  /**
   * Connect a single adapter.
   */
  private async connectAdapter(
    adapter: ChannelAdapter,
    config: ChannelConfig
  ): Promise<void> {
    try {
      // Wire up inbound message handling
      adapter.onMessage(async (msg) => {
        await this.handleInboundMessage(adapter, msg);
      });

      await adapter.connect(config);
      this.emit({ type: "connected", channel: adapter.id });
      console.log(`[channel:${adapter.id}] Connected`);
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      this.emit({ type: "error", channel: adapter.id, error });
      console.error(`[channel:${adapter.id}] Connection failed:`, error.message);
    }
  }

  /**
   * Disconnect all adapters.
   */
  async disconnectAll(): Promise<void> {
    const promises: Promise<void>[] = [];

    for (const [, adapter] of this.adapters) {
      if (adapter.connected) {
        promises.push(
          adapter.disconnect().catch((err) => {
            console.error(`[channel:${adapter.id}] Disconnect error:`, err);
          })
        );
      }
    }

    await Promise.allSettled(promises);
  }

  // ─── Inbound Message Handling ──────────────────────────────────

  /**
   * Handle an inbound message from a channel adapter.
   */
  private async handleInboundMessage(
    adapter: ChannelAdapter,
    message: ChannelMessage
  ): Promise<void> {
    // Dedup: skip if already processing this message
    const msgKey = `${message.channel}:${message.messageId}`;
    if (this.processing.has(msgKey)) return;
    this.processing.add(msgKey);

    try {
      // Check allowlist
      if (!adapter.isAllowed(message.senderId)) {
        this.emit({
          type: "message_blocked",
          channel: adapter.id,
          senderId: message.senderId,
          reason: "Not in allowlist",
        });
        console.log(
          `[channel:${adapter.id}] Blocked message from ${message.senderId} (not in allowlist)`
        );
        return;
      }

      this.emit({
        type: "message_received",
        channel: adapter.id,
        message,
      });

      // Route to message handler
      if (!this.messageHandler) {
        console.warn(`[channel:${adapter.id}] No message handler registered, dropping message`);
        return;
      }

      const responseText = await this.messageHandler(message);

      if (responseText && responseText.trim().length > 0) {
        const result = await adapter.send(message.chatId, responseText);
        this.emit({
          type: "message_sent",
          channel: adapter.id,
          chatId: message.chatId,
          chunksCount: result.chunksCount,
        });
      }
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      this.emit({ type: "error", channel: adapter.id, error });
      console.error(`[channel:${adapter.id}] Error handling message:`, error.message);
    } finally {
      this.processing.delete(msgKey);
    }
  }

  // ─── Manual Send ───────────────────────────────────────────────

  /**
   * Send a message to a specific channel and chat.
   */
  async send(channelId: ChannelId, chatId: string, text: string): Promise<SendResult> {
    const adapter = this.adapters.get(channelId);
    if (!adapter) {
      return { success: false, messageIds: [], chunksCount: 0, error: `Channel ${channelId} not registered` };
    }
    if (!adapter.connected) {
      return { success: false, messageIds: [], chunksCount: 0, error: `Channel ${channelId} not connected` };
    }

    return adapter.send(chatId, text);
  }

  // ─── Query ─────────────────────────────────────────────────────

  /**
   * Get a registered adapter by channel ID.
   */
  getAdapter(channelId: ChannelId): ChannelAdapter | undefined {
    return this.adapters.get(channelId);
  }

  /**
   * Get all registered adapter IDs.
   */
  getRegisteredChannels(): ChannelId[] {
    return Array.from(this.adapters.keys());
  }

  /**
   * Get all connected adapter IDs.
   */
  getConnectedChannels(): ChannelId[] {
    return Array.from(this.adapters.entries())
      .filter(([, adapter]) => adapter.connected)
      .map(([id]) => id);
  }

  // ─── Events ────────────────────────────────────────────────────

  private emit(event: ChannelEvent): void {
    for (const listener of this.eventListeners) {
      try {
        listener(event);
      } catch {
        // Never let listener errors crash the channel system
      }
    }
  }
}
