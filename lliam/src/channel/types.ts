/**
 * Channel System Type Definitions
 *
 * Defines the core interfaces for multi-channel messaging:
 * - ChannelAdapter: connect, receive, send messages across platforms
 * - ChannelMessage: normalized inbound message format
 * - ChannelConfig: per-channel configuration
 *
 * Simplified from OpenClaw's multi-user model for single-user local use.
 */

// ─── Channel Identifiers ─────────────────────────────────────────

export type ChannelId = "telegram" | "imessage";

// ─── Normalized Inbound Message ──────────────────────────────────

/**
 * Platform-agnostic representation of an inbound message.
 * Every channel adapter normalizes its raw messages into this format.
 */
export interface ChannelMessage {
  /** Unique message ID (platform-specific) */
  messageId: string;

  /** Channel this message came from */
  channel: ChannelId;

  /** Sender identifier (Telegram user ID, iMessage handle) */
  senderId: string;

  /** Human-readable sender name */
  senderName: string;

  /** Chat/conversation ID (may differ from senderId in groups) */
  chatId: string;

  /** Message text content */
  text: string;

  /** Whether this is a group message */
  isGroup: boolean;

  /** Timestamp of the message */
  timestamp: number;

  /** Optional: ID of the message being replied to */
  replyToId?: string;

  /** Raw platform-specific data (for pass-through if needed) */
  raw?: unknown;
}

// ─── Channel Adapter Interface ───────────────────────────────────

/**
 * Lifecycle interface for a channel adapter.
 * Each platform (Telegram, iMessage) implements this.
 */
export interface ChannelAdapter {
  /** Channel identifier */
  readonly id: ChannelId;

  /** Human-readable channel name */
  readonly name: string;

  /** Whether the adapter is currently connected */
  readonly connected: boolean;

  /**
   * Connect to the platform and start receiving messages.
   * @param config Channel-specific configuration
   */
  connect(config: ChannelConfig): Promise<void>;

  /**
   * Register a handler for inbound messages.
   * Called after connect().
   */
  onMessage(handler: (msg: ChannelMessage) => Promise<void>): void;

  /**
   * Send a text message to a specific target.
   * Handles chunking internally based on platform limits.
   */
  send(chatId: string, text: string): Promise<SendResult>;

  /**
   * Disconnect from the platform gracefully.
   */
  disconnect(): Promise<void>;

  /**
   * Check if a sender is allowed (against allowlist).
   */
  isAllowed(senderId: string): boolean;
}

// ─── Send Result ─────────────────────────────────────────────────

export interface SendResult {
  /** Whether the send was successful */
  success: boolean;

  /** Platform-specific message IDs for sent chunks */
  messageIds: string[];

  /** Number of chunks the message was split into */
  chunksCount: number;

  /** Error message if failed */
  error?: string;
}

// ─── Channel Configuration ───────────────────────────────────────

/**
 * Base channel configuration (common across all channels).
 */
export interface ChannelConfig {
  /** Whether this channel is enabled */
  enabled: boolean;

  /** Allowed sender IDs. Empty = allow all. */
  allowlist: string[];

  /** Max text chunk size for outbound messages */
  textChunkLimit: number;
}

/**
 * Telegram-specific configuration.
 */
export interface TelegramChannelConfig extends ChannelConfig {
  /** Bot token from @BotFather */
  botToken: string;

  /** Use long polling (true) or webhooks (false, requires public URL) */
  polling: boolean;

  /** Whether to respond in groups (not just DMs) */
  allowGroups: boolean;

  /** Require @mention in groups to trigger response */
  requireMention: boolean;
}

/**
 * iMessage-specific configuration (via BlueBubbles).
 */
export interface IMessageChannelConfig extends ChannelConfig {
  /** BlueBubbles server URL (e.g., "http://localhost:1234") */
  serverUrl: string;

  /** BlueBubbles server password */
  password: string;

  /** Polling interval in ms for checking new messages */
  pollIntervalMs: number;
}

// ─── Outbound Formatting ─────────────────────────────────────────

/**
 * Options for formatting outbound messages per channel.
 */
export interface OutboundFormatOptions {
  /** Maximum characters per chunk */
  maxChunkSize: number;

  /** Whether to convert markdown to platform format */
  convertMarkdown: boolean;

  /** Platform-specific format ("html" for Telegram, "plain" for iMessage) */
  format: "html" | "plain" | "markdown";
}

// ─── Channel Events ──────────────────────────────────────────────

/**
 * Events emitted by the channel system.
 */
export type ChannelEvent =
  | { type: "connected"; channel: ChannelId }
  | { type: "disconnected"; channel: ChannelId; reason?: string }
  | { type: "message_received"; channel: ChannelId; message: ChannelMessage }
  | { type: "message_sent"; channel: ChannelId; chatId: string; chunksCount: number }
  | { type: "message_blocked"; channel: ChannelId; senderId: string; reason: string }
  | { type: "error"; channel: ChannelId; error: Error };
