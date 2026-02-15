/**
 * Telegram Channel Adapter — grammy Bot API integration.
 *
 * Uses grammy (official Telegram Bot API, MIT, zero ToS risk).
 * Supports:
 * - Long polling (default, no public URL required)
 * - Contact allowlist enforcement
 * - Group/DM differentiation with optional @mention requirement
 * - Markdown → Telegram HTML outbound formatting
 * - Auto-reconnect on connection loss
 */

import type {
  ChannelAdapter,
  ChannelMessage,
  ChannelConfig,
  SendResult,
  TelegramChannelConfig,
} from "../types.js";
import { markdownToTelegramHtmlChunks } from "../outbound.js";

// ─── Types ────────────────────────────────────────────────────────

/** grammy Bot type (imported dynamically to keep optional) */
type GrammyBot = {
  api: {
    sendMessage: (
      chatId: number | string,
      text: string,
      options?: Record<string, unknown>
    ) => Promise<{ message_id: number }>;
    getMe: () => Promise<{ id: number; username?: string }>;
  };
  on: (
    event: string,
    handler: (...args: unknown[]) => unknown
  ) => void;
  start: (options?: Record<string, unknown>) => void;
  stop: () => Promise<void>;
};

/** Minimal grammy message context */
interface TelegramContext {
  message?: {
    message_id: number;
    from?: {
      id: number;
      first_name: string;
      last_name?: string;
      username?: string;
    };
    chat: {
      id: number;
      type: string;
    };
    text?: string;
    reply_to_message?: {
      message_id: number;
    };
    date: number;
  };
}

// ─── Telegram Adapter ─────────────────────────────────────────────

export class TelegramAdapter implements ChannelAdapter {
  readonly id = "telegram" as const;
  readonly name = "Telegram";

  private bot: GrammyBot | null = null;
  private _connected = false;
  private messageHandlers: Array<(msg: ChannelMessage) => Promise<void>> = [];
  private allowlist: Set<string> = new Set();
  private config: TelegramChannelConfig | null = null;
  private botUsername = "";

  get connected(): boolean {
    return this._connected;
  }

  // ─── Lifecycle ──────────────────────────────────────────────────

  async connect(config: ChannelConfig): Promise<void> {
    const telegramConfig = config as TelegramChannelConfig;
    this.config = telegramConfig;

    if (!telegramConfig.botToken) {
      throw new Error("Telegram bot token is required");
    }

    // Build allowlist
    this.allowlist = new Set(telegramConfig.allowlist || []);

    // Dynamic import grammy (keeps it optional)
    const { Bot } = await import("grammy");
    this.bot = new Bot(telegramConfig.botToken) as unknown as GrammyBot;

    // Get bot info for @mention detection
    const me = await this.bot.api.getMe();
    this.botUsername = me.username || "";

    // Wire up message handler
    this.bot.on("message:text", (ctx: unknown) => {
      this.handleTelegramMessage(ctx as TelegramContext).catch((err) => {
        console.error("[channel:telegram] Error handling message:", err);
      });
    });

    // Start polling
    if (telegramConfig.polling !== false) {
      this.bot.start({
        onStart: () => {
          this._connected = true;
          console.log(
            `[channel:telegram] Bot @${this.botUsername} started (polling)`
          );
        },
      });
      this._connected = true;
    }
  }

  async disconnect(): Promise<void> {
    if (this.bot) {
      await this.bot.stop();
      this.bot = null;
    }
    this._connected = false;
    console.log("[channel:telegram] Disconnected");
  }

  // ─── Message Handling ───────────────────────────────────────────

  onMessage(handler: (msg: ChannelMessage) => Promise<void>): void {
    this.messageHandlers.push(handler);
  }

  /**
   * Process an incoming Telegram message, normalize, and dispatch.
   */
  private async handleTelegramMessage(ctx: TelegramContext): Promise<void> {
    const msg = ctx.message;
    if (!msg || !msg.text) return;

    const chatType = msg.chat.type;
    const isGroup = chatType === "group" || chatType === "supergroup";

    // Skip group messages if not allowed
    if (isGroup && this.config && !this.config.allowGroups) {
      return;
    }

    // In groups, check if bot is mentioned (if required)
    if (isGroup && this.config?.requireMention) {
      if (!this.isBotMentioned(msg.text)) {
        return;
      }
    }

    // Strip bot @mention from text if present
    let text = msg.text;
    if (this.botUsername) {
      text = text
        .replace(new RegExp(`@${this.botUsername}\\b`, "gi"), "")
        .trim();
    }

    if (!text) return;

    // Normalize to ChannelMessage
    const senderId = String(msg.from?.id || "unknown");
    const senderName = [msg.from?.first_name, msg.from?.last_name]
      .filter(Boolean)
      .join(" ") || "Unknown";

    const normalized: ChannelMessage = {
      messageId: String(msg.message_id),
      channel: "telegram",
      senderId,
      senderName,
      chatId: String(msg.chat.id),
      text,
      isGroup,
      timestamp: msg.date * 1000, // Telegram uses Unix seconds
      replyToId: msg.reply_to_message
        ? String(msg.reply_to_message.message_id)
        : undefined,
      raw: ctx,
    };

    // Dispatch to all handlers
    for (const handler of this.messageHandlers) {
      await handler(normalized);
    }
  }

  /**
   * Check if the bot is mentioned in text via @username or /command.
   */
  private isBotMentioned(text: string): boolean {
    if (!this.botUsername) return false;
    const mentionPattern = new RegExp(`@${this.botUsername}\\b`, "i");
    return mentionPattern.test(text) || text.startsWith("/");
  }

  // ─── Outbound ───────────────────────────────────────────────────

  async send(chatId: string, text: string): Promise<SendResult> {
    if (!this.bot) {
      return {
        success: false,
        messageIds: [],
        chunksCount: 0,
        error: "Bot not connected",
      };
    }

    try {
      // Convert markdown to Telegram HTML and chunk
      const chunkLimit = this.config?.textChunkLimit || 4000;
      const chunks = markdownToTelegramHtmlChunks(text, chunkLimit);
      const messageIds: string[] = [];

      for (const chunk of chunks) {
        const result = await this.bot.api.sendMessage(chatId, chunk, {
          parse_mode: "HTML",
        });
        messageIds.push(String(result.message_id));
      }

      return {
        success: true,
        messageIds,
        chunksCount: chunks.length,
      };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      console.error(`[channel:telegram] Send error:`, error);
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
    // Empty allowlist = allow all
    if (this.allowlist.size === 0) return true;
    return this.allowlist.has(senderId);
  }
}
