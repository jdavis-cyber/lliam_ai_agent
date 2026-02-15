import type { WebSocket } from "ws";
import { Agent } from "../core/agent.js";
import type { SessionManager } from "../session/manager.js";
import type { AgentConfig } from "../types/index.js";
import { ApiKeyAuthenticator } from "./auth.js";
import {
  parseRequestFrame,
  successResponse,
  errorResponse,
  type ChatUpdateEvent,
  type ChatFinalEvent,
  type ChatErrorEvent,
} from "./frames.js";

// ─── Rate Limiter ───────────────────────────────────────────────────────────

class RateLimiter {
  private timestamps: number[] = [];
  private maxPerMinute: number;

  constructor(maxPerMinute: number) {
    this.maxPerMinute = maxPerMinute;
  }

  check(): boolean {
    const now = Date.now();
    const oneMinuteAgo = now - 60_000;

    // Remove old timestamps
    this.timestamps = this.timestamps.filter((t) => t > oneMinuteAgo);

    if (this.timestamps.length >= this.maxPerMinute) {
      return false;
    }

    this.timestamps.push(now);
    return true;
  }
}

// ─── Connection State ───────────────────────────────────────────────────────

interface ConnectionState {
  ws: WebSocket;
  authenticated: boolean;
  rateLimiter: RateLimiter;
  connectedAt: number;
  lastActivity: number;
}

// ─── WebSocket Handler ──────────────────────────────────────────────────────

export class WebSocketHandler {
  private sessionManager: SessionManager;
  private agentConfig: AgentConfig;
  private auth: ApiKeyAuthenticator | null;
  private rateLimitPerMinute: number;
  private connections: Set<ConnectionState> = new Set();

  constructor(options: {
    sessionManager: SessionManager;
    agentConfig: AgentConfig;
    auth: ApiKeyAuthenticator | null;
    rateLimitPerMinute: number;
  }) {
    this.sessionManager = options.sessionManager;
    this.agentConfig = options.agentConfig;
    this.auth = options.auth;
    this.rateLimitPerMinute = options.rateLimitPerMinute;
  }

  /**
   * Handle a new WebSocket connection.
   */
  handleConnection(ws: WebSocket, apiKeyFromUpgrade?: string): void {
    const state: ConnectionState = {
      ws,
      authenticated: false,
      rateLimiter: new RateLimiter(this.rateLimitPerMinute),
      connectedAt: Date.now(),
      lastActivity: Date.now(),
    };

    // If no auth configured, auto-authenticate
    if (!this.auth) {
      state.authenticated = true;
    } else if (apiKeyFromUpgrade && this.auth.validate(apiKeyFromUpgrade)) {
      state.authenticated = true;
    }

    if (!state.authenticated) {
      this.send(ws, errorResponse("auth", "Authentication required. Provide apiKey query param or Authorization header."));
      ws.close(4001, "Unauthorized");
      return;
    }

    this.connections.add(state);

    // Send welcome
    this.send(ws, successResponse("connect", {
      message: "Connected to Lliam gateway",
      timestamp: Date.now(),
    }));

    // Handle messages
    ws.on("message", (data) => {
      state.lastActivity = Date.now();
      this.handleMessage(state, data.toString());
    });

    ws.on("close", () => {
      this.connections.delete(state);
    });

    ws.on("error", () => {
      this.connections.delete(state);
    });
  }

  /**
   * Handle an incoming WebSocket message.
   */
  private async handleMessage(
    state: ConnectionState,
    raw: string
  ): Promise<void> {
    const { ws } = state;

    // Rate limit check
    if (!state.rateLimiter.check()) {
      this.send(ws, errorResponse("rate_limit", "Rate limit exceeded. Max " + this.rateLimitPerMinute + " messages per minute."));
      return;
    }

    // Parse frame
    const frame = parseRequestFrame(raw);
    if (!frame) {
      this.send(ws, errorResponse("parse_error", "Invalid request frame."));
      return;
    }

    // Dispatch by method
    try {
      switch (frame.method) {
        case "agent.message":
          await this.handleAgentMessage(ws, frame.requestId, frame.params);
          break;
        case "sessions.list":
          this.handleSessionsList(ws, frame.requestId);
          break;
        case "sessions.create":
          this.handleSessionsCreate(ws, frame.requestId, frame.params);
          break;
        case "sessions.get":
          this.handleSessionsGet(ws, frame.requestId, frame.params);
          break;
        case "sessions.delete":
          this.handleSessionsDelete(ws, frame.requestId, frame.params);
          break;
        case "ping":
          this.send(ws, successResponse(frame.requestId, { pong: Date.now() }));
          break;
        default:
          this.send(ws, errorResponse(frame.requestId, `Unknown method: ${frame.method}`));
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : "Internal error";
      this.send(ws, errorResponse(frame.requestId, msg));
    }
  }

  // ─── Method Handlers ────────────────────────────────────────────────────

  /**
   * Handle agent.message — send user message to Claude, stream response back.
   */
  private async handleAgentMessage(
    ws: WebSocket,
    requestId: string,
    params: Record<string, unknown> | undefined
  ): Promise<void> {
    const sessionId = (params?.sessionId as string) ?? null;
    const message = params?.message as string;

    if (!message || typeof message !== "string") {
      this.send(ws, errorResponse(requestId, "Missing required param: message"));
      return;
    }

    // Resolve or create session
    let resolvedSessionId = sessionId;
    if (!resolvedSessionId) {
      const session = this.sessionManager.createSession();
      resolvedSessionId = session.sessionId;
    } else if (!this.sessionManager.sessionExists(resolvedSessionId)) {
      const session = this.sessionManager.createSession();
      resolvedSessionId = session.sessionId;
    }

    // Add user message to session
    await this.sessionManager.addMessage(resolvedSessionId, {
      role: "user",
      content: message,
      timestamp: Date.now(),
    });

    // Create agent with conversation history
    const agent = new Agent(this.agentConfig);
    const history = this.sessionManager.getHistory(resolvedSessionId);

    // Rebuild agent history (skip last message since we'll send it fresh)
    for (const msg of history.slice(0, -1)) {
      if (msg.role === "user" || msg.role === "assistant") {
        agent["conversationHistory"].push(msg);
      }
    }

    // Acknowledge the request
    this.send(ws, successResponse(requestId, {
      sessionId: resolvedSessionId,
      status: "streaming",
    }));

    try {
      // Stream response
      const response = await agent.executeMessage(message, (chunk: string) => {
        const event: ChatUpdateEvent = {
          type: "event",
          event: "chat.update",
          payload: {
            requestId,
            sessionId: resolvedSessionId!,
            delta: chunk,
          },
        };
        this.send(ws, event);
      });

      // Save assistant message to session
      await this.sessionManager.addMessage(resolvedSessionId, {
        role: "assistant",
        content: response.content,
        timestamp: Date.now(),
        metadata: {
          model: response.model,
          tokenUsage: response.tokenUsage,
        },
      });

      // Send final event
      const finalEvent: ChatFinalEvent = {
        type: "event",
        event: "chat.final",
        payload: {
          requestId,
          sessionId: resolvedSessionId,
          content: response.content,
          model: response.model,
          tokenUsage: response.tokenUsage,
          stopReason: response.stopReason,
        },
      };
      this.send(ws, finalEvent);
    } catch (error) {
      const errorEvent: ChatErrorEvent = {
        type: "event",
        event: "chat.error",
        payload: {
          requestId,
          sessionId: resolvedSessionId,
          error: error instanceof Error ? error.message : "Agent execution failed",
        },
      };
      this.send(ws, errorEvent);
    }
  }

  private handleSessionsList(ws: WebSocket, requestId: string): void {
    const sessions = this.sessionManager.listSessions();
    this.send(ws, successResponse(requestId, { sessions }));
  }

  private handleSessionsCreate(
    ws: WebSocket,
    requestId: string,
    params: Record<string, unknown> | undefined
  ): void {
    const title = params?.title as string | undefined;
    const session = this.sessionManager.createSession(title);
    this.send(ws, successResponse(requestId, {
      sessionId: session.sessionId,
      title: session.title,
      created: session.created,
    }));
  }

  private handleSessionsGet(
    ws: WebSocket,
    requestId: string,
    params: Record<string, unknown> | undefined
  ): void {
    const sessionId = params?.sessionId as string;
    if (!sessionId) {
      this.send(ws, errorResponse(requestId, "Missing required param: sessionId"));
      return;
    }

    const session = this.sessionManager.getSession(sessionId);
    if (!session) {
      this.send(ws, errorResponse(requestId, `Session not found: ${sessionId}`));
      return;
    }

    this.send(ws, successResponse(requestId, { session }));
  }

  private handleSessionsDelete(
    ws: WebSocket,
    requestId: string,
    params: Record<string, unknown> | undefined
  ): void {
    const sessionId = params?.sessionId as string;
    if (!sessionId) {
      this.send(ws, errorResponse(requestId, "Missing required param: sessionId"));
      return;
    }

    const deleted = this.sessionManager.deleteSession(sessionId);
    this.send(ws, successResponse(requestId, { deleted }));
  }

  // ─── Utilities ──────────────────────────────────────────────────────────

  private send(ws: WebSocket, frame: unknown): void {
    if (ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify(frame));
    }
  }

  /**
   * Get count of active connections.
   */
  getConnectionCount(): number {
    return this.connections.size;
  }

  /**
   * Broadcast a heartbeat to all connected clients.
   */
  broadcastHeartbeat(uptime: number): void {
    const event = {
      type: "event",
      event: "heartbeat",
      payload: { timestamp: Date.now(), uptime },
    };

    for (const state of this.connections) {
      this.send(state.ws, event);
    }
  }

  /**
   * Close all connections (for graceful shutdown).
   */
  closeAll(): void {
    for (const state of this.connections) {
      state.ws.close(1001, "Server shutting down");
    }
    this.connections.clear();
  }
}
