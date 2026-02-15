import { z } from "zod";
import { AgentConfigSchema } from "../types/index.js";

// ─── Gateway Config ─────────────────────────────────────────────────────────

export const GatewayConfigSchema = z.object({
  /** Port to bind the gateway server on */
  port: z.number().min(1024).max(65535).default(3000),

  /** Host to bind to — localhost only for security */
  host: z.string().default("127.0.0.1"),

  /** API key for authenticating WebSocket and REST connections */
  apiKey: z
    .string()
    .min(32, "API key must be at least 32 characters for security")
    .optional(),

  /** Maximum messages per minute per connection (rate limiting) */
  rateLimitPerMinute: z.number().min(1).max(1000).default(30),

  /** WebSocket heartbeat interval in milliseconds */
  heartbeatIntervalMs: z.number().min(1000).max(60000).default(30000),

  /** Connection timeout in milliseconds — close idle connections */
  connectionTimeoutMs: z.number().min(10000).max(600000).default(300000),
});

export type GatewayConfig = z.infer<typeof GatewayConfigSchema>;

// ─── Session Config ─────────────────────────────────────────────────────────

export const SessionConfigSchema = z.object({
  /** Directory to store session transcript files */
  dir: z.string().default("sessions"),

  /** Maximum number of messages to keep in a session before compaction */
  maxMessages: z.number().min(10).max(10000).default(200),

  /** Maximum number of sessions to keep */
  maxSessions: z.number().min(1).max(10000).default(100),
});

export type SessionConfig = z.infer<typeof SessionConfigSchema>;

// ─── Channel Config ─────────────────────────────────────────────────────────

export const TelegramConfigSchema = z.object({
  /** Whether Telegram channel is enabled */
  enabled: z.boolean().default(false),

  /** Bot token from @BotFather (env: LLIAM_TELEGRAM_BOT_TOKEN) */
  botToken: z.string().default(""),

  /** Use long polling (true) vs webhooks (false) */
  polling: z.boolean().default(true),

  /** Allow bot to respond in group chats */
  allowGroups: z.boolean().default(false),

  /** Require @mention in groups to trigger response */
  requireMention: z.boolean().default(true),

  /** Allowed Telegram user IDs. Empty = allow all. */
  allowlist: z.array(z.string()).default([]),

  /** Max text chunk size for outbound messages */
  textChunkLimit: z.number().min(500).max(4096).default(4000),
});

export type TelegramConfig = z.infer<typeof TelegramConfigSchema>;

export const IMessageConfigSchema = z.object({
  /** Whether iMessage channel is enabled */
  enabled: z.boolean().default(false),

  /** BlueBubbles server URL */
  serverUrl: z.string().default("http://localhost:1234"),

  /** BlueBubbles server password (env: LLIAM_IMESSAGE_PASSWORD) */
  password: z.string().default(""),

  /** Polling interval in ms for checking new messages */
  pollIntervalMs: z.number().min(1000).max(60000).default(5000),

  /** Allowed iMessage handles (phone/email). Empty = allow all. */
  allowlist: z.array(z.string()).default([]),

  /** Max text chunk size for outbound messages */
  textChunkLimit: z.number().min(500).max(5000).default(2000),
});

export type IMessageConfig = z.infer<typeof IMessageConfigSchema>;

export const ChannelsConfigSchema = z.object({
  telegram: TelegramConfigSchema.default({}),
  imessage: IMessageConfigSchema.default({}),
});

export type ChannelsConfig = z.infer<typeof ChannelsConfigSchema>;

// ─── Full App Config ────────────────────────────────────────────────────────

export const AppConfigSchema = z.object({
  /** Base data directory for all Lliam data */
  dataDir: z.string().default("~/.lliam"),

  /** Log level */
  logLevel: z.enum(["debug", "info", "warn", "error"]).default("info"),

  /** Gateway server configuration */
  gateway: GatewayConfigSchema.default({}),

  /** Agent (Claude) configuration */
  agent: AgentConfigSchema.default({}),

  /** Session persistence configuration */
  sessions: SessionConfigSchema.default({}),

  /** Channel configurations (Telegram, iMessage) */
  channels: ChannelsConfigSchema.default({}),
});

export type AppConfig = z.infer<typeof AppConfigSchema>;

// ─── Config Loader ──────────────────────────────────────────────────────────

/**
 * Resolve ~ to the user's home directory.
 */
export function expandHome(filepath: string): string {
  if (filepath.startsWith("~/") || filepath === "~") {
    const home = process.env.HOME ?? process.env.USERPROFILE ?? "/tmp";
    return filepath.replace("~", home);
  }
  return filepath;
}

/**
 * Load and validate configuration from environment variables and defaults.
 * In the future, this will also load from a YAML config file.
 */
export function loadConfig(overrides?: Partial<AppConfig>): AppConfig {
  const raw = {
    dataDir: process.env.LLIAM_DATA_DIR ?? "~/.lliam",
    logLevel: process.env.LLIAM_LOG_LEVEL ?? "info",
    gateway: {
      port: process.env.LLIAM_GATEWAY_PORT
        ? parseInt(process.env.LLIAM_GATEWAY_PORT, 10)
        : undefined,
      host: process.env.LLIAM_GATEWAY_HOST ?? undefined,
      apiKey: process.env.LLIAM_API_KEY ?? undefined,
    },
    agent: {
      model: process.env.LLIAM_MODEL ?? undefined,
    },
    channels: {
      telegram: {
        enabled: process.env.LLIAM_TELEGRAM_ENABLED === "true" ? true : undefined,
        botToken: process.env.LLIAM_TELEGRAM_BOT_TOKEN ?? undefined,
        allowlist: process.env.LLIAM_TELEGRAM_ALLOWLIST
          ? process.env.LLIAM_TELEGRAM_ALLOWLIST.split(",").map((s) => s.trim())
          : undefined,
      },
      imessage: {
        enabled: process.env.LLIAM_IMESSAGE_ENABLED === "true" ? true : undefined,
        serverUrl: process.env.LLIAM_IMESSAGE_SERVER_URL ?? undefined,
        password: process.env.LLIAM_IMESSAGE_PASSWORD ?? undefined,
        allowlist: process.env.LLIAM_IMESSAGE_ALLOWLIST
          ? process.env.LLIAM_IMESSAGE_ALLOWLIST.split(",").map((s) => s.trim())
          : undefined,
      },
    },
    ...overrides,
  };

  const config = AppConfigSchema.parse(raw);

  // Expand home directory in dataDir
  config.dataDir = expandHome(config.dataDir);

  return config;
}
