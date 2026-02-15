import { createServer, type Server as HttpServer } from "node:http";
import express from "express";
import { WebSocketServer, type WebSocket } from "ws";
import type { IncomingMessage } from "node:http";
import { URL } from "node:url";

import { ApiKeyAuthenticator } from "./auth.js";
import { WebSocketHandler } from "./websocket-handler.js";
import { createRoutes } from "./routes.js";
import { SessionManager } from "../session/manager.js";
import { FileSystemSessionStorage } from "../session/persistence.js";
import { expandHome, type AppConfig } from "../config/schema.js";
import { ChannelHandler } from "./channel-handler.js";

// ─── Gateway Server ─────────────────────────────────────────────────────────

export interface GatewayServerState {
  httpServer: HttpServer;
  wss: WebSocketServer;
  wsHandler: WebSocketHandler;
  sessionManager: SessionManager;
  channelHandler: ChannelHandler | null;
  startedAt: number;
  heartbeatInterval: ReturnType<typeof setInterval> | null;
}

/**
 * Start the Lliam gateway server.
 *
 * Security:
 * - Binds to localhost only (127.0.0.1) by default
 * - API key authentication on all WebSocket connections
 * - API key authentication on all REST routes via middleware
 * - Rate limiting per WebSocket connection
 * - Heartbeat to detect stale connections
 */
export async function startGatewayServer(
  config: AppConfig
): Promise<GatewayServerState> {
  const dataDir = expandHome(config.dataDir);
  const { gateway, agent } = config;

  // ─── Session Storage ────────────────────────────────────────────────

  const storage = new FileSystemSessionStorage(dataDir, config.sessions.dir);
  const sessionManager = new SessionManager(storage);

  // ─── Auth ───────────────────────────────────────────────────────────

  const auth = gateway.apiKey
    ? new ApiKeyAuthenticator(gateway.apiKey)
    : null;

  if (!auth) {
    console.warn(
      "  WARNING: No API key configured. Gateway is OPEN to anyone on localhost."
    );
    console.warn(
      '  Set LLIAM_API_KEY environment variable or add apiKey to config.\n'
    );
  }

  // ─── Express App ────────────────────────────────────────────────────

  const app = express();
  app.use(express.json());

  // Auth middleware for REST routes
  if (auth) {
    app.use("/api", (req, res, next) => {
      const key = ApiKeyAuthenticator.extractFromHeader(
        req.headers.authorization
      );
      if (!key || !auth.validate(key)) {
        res.status(401).json({ ok: false, error: "Unauthorized" });
        return;
      }
      next();
    });
  }

  // REST routes
  app.use(createRoutes(sessionManager));

  // ─── HTTP Server ────────────────────────────────────────────────────

  const httpServer = createServer(app);

  // ─── WebSocket Server ───────────────────────────────────────────────

  const wss = new WebSocketServer({ noServer: true });

  const wsHandler = new WebSocketHandler({
    sessionManager,
    agentConfig: agent,
    auth,
    rateLimitPerMinute: gateway.rateLimitPerMinute,
  });

  // Handle WebSocket upgrade
  httpServer.on("upgrade", (request: IncomingMessage, socket, head) => {
    // Extract API key from query string
    let apiKey: string | undefined;
    try {
      const url = new URL(request.url ?? "", `http://${request.headers.host}`);
      apiKey =
        url.searchParams.get("apiKey") ??
        url.searchParams.get("api_key") ??
        undefined;
    } catch {
      // Malformed URL
    }

    // Also check Authorization header
    if (!apiKey) {
      apiKey =
        ApiKeyAuthenticator.extractFromHeader(request.headers.authorization) ??
        undefined;
    }

    wss.handleUpgrade(request, socket, head, (ws: WebSocket) => {
      wss.emit("connection", ws, request);
      wsHandler.handleConnection(ws, apiKey);
    });
  });

  // ─── Heartbeat ──────────────────────────────────────────────────────

  const startedAt = Date.now();
  const heartbeatInterval = setInterval(() => {
    const uptime = Math.floor((Date.now() - startedAt) / 1000);
    wsHandler.broadcastHeartbeat(uptime);
  }, gateway.heartbeatIntervalMs);

  // ─── Start Listening ────────────────────────────────────────────────

  await new Promise<void>((resolve, reject) => {
    httpServer.on("error", reject);
    httpServer.listen(gateway.port, gateway.host, () => {
      resolve();
    });
  });

  console.log(`  Lliam gateway running on http://${gateway.host}:${gateway.port}`);
  console.log(`  WebSocket endpoint: ws://${gateway.host}:${gateway.port}/ws`);
  console.log(`  REST API: http://${gateway.host}:${gateway.port}/api`);
  console.log(`  Data directory: ${dataDir}`);
  console.log(`  Auth: ${auth ? "API key required" : "OPEN (no auth)"}`);

  // ─── Channel Adapters ─────────────────────────────────────────────

  let channelHandler: ChannelHandler | null = null;
  const channels = config.channels;

  if (channels?.telegram?.enabled || channels?.imessage?.enabled) {
    channelHandler = new ChannelHandler({
      sessionManager,
      agentConfig: agent,
      telegram: channels.telegram?.enabled ? channels.telegram : undefined,
      imessage: channels.imessage?.enabled ? channels.imessage : undefined,
    });

    try {
      await channelHandler.connectAll();
    } catch (err) {
      console.error("  Channel connection error:", err);
    }
  }

  return {
    httpServer,
    wss,
    wsHandler,
    sessionManager,
    channelHandler,
    startedAt,
    heartbeatInterval,
  };
}

/**
 * Gracefully shut down the gateway server.
 */
export async function stopGatewayServer(
  state: GatewayServerState
): Promise<void> {
  // Stop heartbeat
  if (state.heartbeatInterval) {
    clearInterval(state.heartbeatInterval);
  }

  // Disconnect channel adapters
  if (state.channelHandler) {
    await state.channelHandler.disconnectAll();
  }

  // Close all WebSocket connections
  state.wsHandler.closeAll();

  // Close WebSocket server
  state.wss.close();

  // Close HTTP server
  await new Promise<void>((resolve) => {
    state.httpServer.close(() => resolve());
  });

  console.log("  Lliam gateway stopped.");
}
