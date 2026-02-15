import { z } from "zod";

// ─── Message Types ──────────────────────────────────────────────────────────

export type MessageRole = "user" | "assistant" | "system";

export interface Message {
  role: MessageRole;
  content: string;
  timestamp: number;
  metadata?: MessageMetadata;
}

export interface MessageMetadata {
  model?: string;
  tokenUsage?: TokenUsage;
  toolCalls?: ToolCall[];
  sessionId?: string;
  channelId?: string;
  /** Channel-specific metadata for messages from Telegram/iMessage */
  channel?: string;
  senderId?: string;
  senderName?: string;
  chatId?: string;
  messageId?: string;
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface ToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
  output?: string;
  error?: string;
  durationMs?: number;
}

// ─── Tool Types ─────────────────────────────────────────────────────────────

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: ToolParameterSchema;
}

export interface ToolParameterSchema {
  type: "object";
  properties: Record<string, ToolParameterProperty>;
  required?: string[];
  [key: string]: unknown;
}

export interface ToolParameterProperty {
  type: string;
  description: string;
  enum?: string[];
  default?: unknown;
  [key: string]: unknown;
}

export type ToolExecuteFn = (
  toolCallId: string,
  params: Record<string, unknown>,
) => Promise<ToolResult>;

export interface ToolResult {
  content: string;
  isError?: boolean;
}

// ─── Agent Config ───────────────────────────────────────────────────────────

export const AgentConfigSchema = z.object({
  model: z.string().default("claude-sonnet-4-20250514"),
  temperature: z.number().min(0).max(1).default(0.7),
  maxTokens: z.number().min(1).max(128000).default(4096),
  systemPrompt: z.string().optional(),
  maxRetries: z.number().min(0).max(5).default(3),
  retryDelayMs: z.number().min(100).max(30000).default(1000),
});

export type AgentConfig = z.infer<typeof AgentConfigSchema>;

// ─── App Config ─────────────────────────────────────────────────────────────

export const AppConfigSchema = z.object({
  dataDir: z.string().default("~/.lliam"),
  logLevel: z.enum(["debug", "info", "warn", "error"]).default("info"),
  agent: AgentConfigSchema.default({}),
});

export type AppConfig = z.infer<typeof AppConfigSchema>;

// ─── Streaming Types ────────────────────────────────────────────────────────

export type StreamChunkCallback = (chunk: string) => void;

export interface AgentResponse {
  content: string;
  tokenUsage: TokenUsage;
  model: string;
  stopReason: string | null;
  toolCalls: ToolCall[];
}
