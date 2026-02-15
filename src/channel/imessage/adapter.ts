/**
 * iMessage Channel Adapter — BlueBubbles REST API integration.
 *
 * Connects to a BlueBubbles server running on macOS to send/receive iMessages.
 * Uses:
 * - Polling for inbound messages (configurable interval)
 * - REST API for outbound messages
 * - Contact allowlist enforcement by iMessage handle (phone/email)
 *
 * Requires:
 * - BlueBubbles server running on macOS with a valid Apple ID
 * - Server URL and password configured
 */

import type {
  ChannelAdapter,
  ChannelMessage,
  ChannelConfig,
  SendResult,
  IMessageChannelConfig,
} from "../types.js";
import { chunkText, markdownToPlainText } from "../outbound.js";

// ─── BlueBubbles API Types ────────────────────────────────────────

interface BlueBubblesMessage {
  guid: string;
  text: string | null;
  handle?: {
    address: string;
    service: string;
  };
  chats?: Array<{
    guid: string;
    chatIdentifier: string;
    displayName?: string;
    participants?: Array<{
      address: string;
    }>;
  }>;
  dateCreated: number;
  isFromMe: boolean;
  associatedMessageGuid?: string;
  associatedMessageType?: number;
}

interface BlueBubblesResponse<T> {
  status: number;
  message: string;
  data: T;
  metadata?: {
    total?: number;
    offset?: number;
    limit?: number;
  };
}

// ─── iMessage Adapter ─────────────────────────────────────────────

export class IMessageAdapter implements ChannelAdapter {
  readonly id = "imessage" as const;
  readonly name = "iMessage";

  private _connected = false;
  private messageHandlers: Array<(msg: ChannelMessage) => Promise<void>> = [];
  private allowlist: Set<string> = new Set();
  private config: IMessageChannelConfig | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private lastPollTimestamp = 0;
  private seenMessageIds = new Set<string>();

  get connected(): boolean {
    return this._connected;
  }

  // ─── Lifecycle ──────────────────────────────────────────────────

  async connect(config: ChannelConfig): Promise<void> {
    const imessageConfig = config as IMessageChannelConfig;
    this.config = imessageConfig;

    if (!imessageConfig.serverUrl) {
      throw new Error("BlueBubbles server URL is required");
    }
    if (!imessageConfig.password) {
      throw new Error("BlueBubbles server password is required");
    }

    // Build allowlist (normalize handles)
    this.allowlist = new Set(
      (imessageConfig.allowlist || []).map((h) => normalizeHandle(h))
    );

    // Verify server connectivity
    await this.ping();

    // Set initial poll timestamp to now (don't process old messages)
    this.lastPollTimestamp = Date.now();

    // Start polling for new messages
    const pollInterval = imessageConfig.pollIntervalMs || 5000;
    this.pollTimer = setInterval(() => {
      this.pollMessages().catch((err) => {
        console.error("[channel:imessage] Poll error:", err);
      });
    }, pollInterval);

    this._connected = true;
    console.log(
      `[channel:imessage] Connected to BlueBubbles at ${imessageConfig.serverUrl} (polling every ${pollInterval}ms)`
    );
  }

  async disconnect(): Promise<void> {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    this._connected = false;
    this.seenMessageIds.clear();
    console.log("[channel:imessage] Disconnected");
  }

  // ─── Message Handling ───────────────────────────────────────────

  onMessage(handler: (msg: ChannelMessage) => Promise<void>): void {
    this.messageHandlers.push(handler);
  }

  /**
   * Poll BlueBubbles for new messages since last check.
   */
  private async pollMessages(): Promise<void> {
    if (!this.config) return;

    try {
      const messages = await this.fetchRecentMessages();

      for (const msg of messages) {
        // Skip our own messages
        if (msg.isFromMe) continue;

        // Skip already-seen messages (dedup)
        if (this.seenMessageIds.has(msg.guid)) continue;
        this.seenMessageIds.add(msg.guid);

        // Skip reactions/tapbacks (associatedMessageType != 0 or null)
        if (msg.associatedMessageType && msg.associatedMessageType !== 0) continue;

        // Skip empty messages
        if (!msg.text || msg.text.trim().length === 0) continue;

        // Normalize and dispatch
        const normalized = this.normalizeMessage(msg);
        if (!normalized) continue;

        for (const handler of this.messageHandlers) {
          await handler(normalized);
        }
      }

      // Update poll timestamp
      this.lastPollTimestamp = Date.now();

      // Prune seen message IDs to prevent memory leak (keep last 1000)
      if (this.seenMessageIds.size > 1000) {
        const entries = Array.from(this.seenMessageIds);
        this.seenMessageIds = new Set(entries.slice(-500));
      }
    } catch (err) {
      console.error("[channel:imessage] Poll error:", err);
    }
  }

  /**
   * Normalize a BlueBubbles message into a ChannelMessage.
   */
  private normalizeMessage(msg: BlueBubblesMessage): ChannelMessage | null {
    const handle = msg.handle?.address;
    if (!handle) return null;

    const chat = msg.chats?.[0];
    const chatId = chat?.guid || handle;
    const isGroup = (chat?.participants?.length || 0) > 1;

    return {
      messageId: msg.guid,
      channel: "imessage",
      senderId: normalizeHandle(handle),
      senderName: handle, // BlueBubbles doesn't always provide names
      chatId,
      text: msg.text || "",
      isGroup,
      timestamp: msg.dateCreated,
      replyToId: msg.associatedMessageGuid || undefined,
      raw: msg,
    };
  }

  // ─── Outbound ───────────────────────────────────────────────────

  async send(chatId: string, text: string): Promise<SendResult> {
    if (!this.config) {
      return {
        success: false,
        messageIds: [],
        chunksCount: 0,
        error: "Adapter not connected",
      };
    }

    try {
      // Convert markdown to plain text for iMessage
      const plainText = markdownToPlainText(text);

      // Chunk at iMessage limit
      const chunkLimit = this.config.textChunkLimit || 2000;
      const chunks = chunkText(plainText, chunkLimit);
      const messageIds: string[] = [];

      for (const chunk of chunks) {
        const result = await this.sendMessage(chatId, chunk);
        if (result) {
          messageIds.push(result);
        }
      }

      return {
        success: true,
        messageIds,
        chunksCount: chunks.length,
      };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      console.error("[channel:imessage] Send error:", error);
      return {
        success: false,
        messageIds: [],
        chunksCount: 0,
        error,
      };
    }
  }

  // ─── Allowlist ──────────────────────────────────────────────────

  isAllowed(senderId: string): boolean {
    if (this.allowlist.size === 0) return true;
    return this.allowlist.has(normalizeHandle(senderId));
  }

  // ─── BlueBubbles API Calls ──────────────────────────────────────

  /**
   * Ping the BlueBubbles server to verify connectivity.
   */
  private async ping(): Promise<void> {
    const response = await this.apiGet<{ message: string }>("/api/v1/ping");
    if (response.status !== 200) {
      throw new Error(
        `BlueBubbles server returned status ${response.status}: ${response.message}`
      );
    }
  }

  /**
   * Fetch recent messages from BlueBubbles.
   */
  private async fetchRecentMessages(): Promise<BlueBubblesMessage[]> {
    const response = await this.apiPost<BlueBubblesMessage[]>(
      "/api/v1/message/query",
      {
        limit: 50,
        offset: 0,
        sort: "DESC",
        after: this.lastPollTimestamp,
        with: ["chat", "handle"],
      }
    );
    return response.data || [];
  }

  /**
   * Send a text message via BlueBubbles.
   */
  private async sendMessage(
    chatGuid: string,
    text: string
  ): Promise<string | null> {
    const response = await this.apiPost<{ guid: string }>(
      "/api/v1/message/text",
      {
        chatGuid,
        message: text,
        method: "private-api", // Use private API for reliability
      }
    );
    return response.data?.guid || null;
  }

  /**
   * Make a GET request to BlueBubbles API.
   */
  private async apiGet<T>(path: string): Promise<BlueBubblesResponse<T>> {
    if (!this.config) throw new Error("Adapter not configured");

    const url = `${this.config.serverUrl}${path}?password=${encodeURIComponent(this.config.password)}`;
    const response = await fetch(url, {
      method: "GET",
      headers: { "Content-Type": "application/json" },
    });

    if (!response.ok) {
      throw new Error(
        `BlueBubbles API error: ${response.status} ${response.statusText}`
      );
    }

    return (await response.json()) as BlueBubblesResponse<T>;
  }

  /**
   * Make a POST request to BlueBubbles API.
   */
  private async apiPost<T>(
    path: string,
    body: Record<string, unknown>
  ): Promise<BlueBubblesResponse<T>> {
    if (!this.config) throw new Error("Adapter not configured");

    const url = `${this.config.serverUrl}${path}?password=${encodeURIComponent(this.config.password)}`;
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      throw new Error(
        `BlueBubbles API error: ${response.status} ${response.statusText}`
      );
    }

    return (await response.json()) as BlueBubblesResponse<T>;
  }
}

// ─── Utility ────────────────────────────────────────────────────

/**
 * Normalize an iMessage handle for consistent comparison.
 * Strips +1 prefix from US phone numbers, lowercases emails.
 */
function normalizeHandle(handle: string): string {
  // Remove whitespace
  let normalized = handle.trim();

  // Email: just lowercase
  if (normalized.includes("@")) {
    return normalized.toLowerCase();
  }

  // Phone: strip formatting, normalize +1
  normalized = normalized.replace(/[\s\-().]/g, "");
  if (normalized.startsWith("+1") && normalized.length === 12) {
    normalized = normalized.slice(2);
  }
  if (normalized.length === 10 && /^\d+$/.test(normalized)) {
    // US 10-digit — keep as-is
    return normalized;
  }

  return normalized;
}

// Export for testing
export { normalizeHandle };
