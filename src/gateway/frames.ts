import { z } from "zod";

// ─── Frame Types ────────────────────────────────────────────────────────────

/**
 * Protocol version for forward compatibility.
 * Clients and servers should negotiate on connect.
 */
export const PROTOCOL_VERSION = 1;

// ─── Request Frame (Client → Server) ────────────────────────────────────────

export const RequestFrameSchema = z.object({
  type: z.literal("request"),
  requestId: z.string().min(1),
  method: z.enum([
    "agent.message",
    "sessions.list",
    "sessions.create",
    "sessions.get",
    "sessions.delete",
    "ping",
  ]),
  params: z.record(z.unknown()).optional(),
});

export type RequestFrame = z.infer<typeof RequestFrameSchema>;

// ─── Response Frame (Server → Client) ───────────────────────────────────────

export interface ResponseFrame {
  type: "response";
  requestId: string;
  ok: boolean;
  payload?: unknown;
  error?: string;
}

// ─── Event Frame (Server → Client, broadcast) ──────────────────────────────

export interface EventFrame {
  type: "event";
  event: string;
  payload: unknown;
}

// ─── Specific Event Types ───────────────────────────────────────────────────

export interface ChatUpdateEvent {
  type: "event";
  event: "chat.update";
  payload: {
    requestId: string;
    sessionId: string;
    delta: string;
  };
}

export interface ChatFinalEvent {
  type: "event";
  event: "chat.final";
  payload: {
    requestId: string;
    sessionId: string;
    content: string;
    model: string;
    tokenUsage: {
      inputTokens: number;
      outputTokens: number;
    };
    stopReason: string | null;
  };
}

export interface ChatErrorEvent {
  type: "event";
  event: "chat.error";
  payload: {
    requestId: string;
    sessionId: string;
    error: string;
  };
}

export interface HeartbeatEvent {
  type: "event";
  event: "heartbeat";
  payload: {
    timestamp: number;
    uptime: number;
  };
}

// ─── Union Type ─────────────────────────────────────────────────────────────

export type ServerFrame = ResponseFrame | EventFrame;
export type ClientFrame = RequestFrame;

// ─── Frame Helpers ──────────────────────────────────────────────────────────

/**
 * Create a success response frame.
 */
export function successResponse(
  requestId: string,
  payload?: unknown
): ResponseFrame {
  return { type: "response", requestId, ok: true, payload };
}

/**
 * Create an error response frame.
 */
export function errorResponse(
  requestId: string,
  error: string
): ResponseFrame {
  return { type: "response", requestId, ok: false, error };
}

/**
 * Parse a raw WebSocket message into a RequestFrame.
 * Returns null if invalid.
 */
export function parseRequestFrame(raw: string): RequestFrame | null {
  try {
    const parsed = JSON.parse(raw);
    const result = RequestFrameSchema.safeParse(parsed);
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}

/**
 * Serialize a frame to JSON string.
 */
export function serializeFrame(frame: ServerFrame): string {
  return JSON.stringify(frame);
}
