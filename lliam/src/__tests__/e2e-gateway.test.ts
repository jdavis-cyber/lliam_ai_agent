import { describe, it, expect, beforeAll, afterAll } from "vitest";
import WebSocket from "ws";
import { WebSocketServer } from "ws";
import { createServer } from "node:http";
import express from "express";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileSystemSessionStorage } from "../session/persistence.js";
import { SessionManager } from "../session/manager.js";
import { WebSocketHandler } from "../gateway/websocket-handler.js";
import { ApiKeyAuthenticator } from "../gateway/auth.js";
import { createRoutes } from "../gateway/routes.js";
import type { AgentConfig } from "../types/index.js";

// ─── Test Setup ──────────────────────────────────────────────────────────────

const TEST_API_KEY = "test-api-key-that-is-at-least-32-chars-long!!";

/**
 * Connect to WebSocket and return both the socket and the welcome
 * message (which may arrive before or concurrent with the `open` event).
 */
function connectWs(
  url: string
): Promise<{ ws: WebSocket; welcome: unknown | null }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    let welcomeMsg: unknown | null = null;

    // Collect the first message (welcome) which may arrive before open resolves
    const messageHandler = (data: WebSocket.Data) => {
      welcomeMsg = JSON.parse(data.toString());
    };
    ws.on("message", messageHandler);

    ws.on("open", () => {
      // Wait a tick for any buffered message to be delivered
      setTimeout(() => {
        ws.removeListener("message", messageHandler);
        resolve({ ws, welcome: welcomeMsg });
      }, 50);
    });
    ws.on("error", reject);
    ws.on("unexpected-response", (_req, res) => {
      reject(new Error(`Unexpected response: ${res.statusCode}`));
    });
  });
}

/**
 * Wait for the next message on a WebSocket.
 */
function waitForMessage(ws: WebSocket, timeoutMs = 5000): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("Timed out waiting for message")),
      timeoutMs
    );
    ws.once("message", (data) => {
      clearTimeout(timer);
      resolve(JSON.parse(data.toString()));
    });
  });
}

// ─── E2E Tests ───────────────────────────────────────────────────────────────

describe("E2E: Gateway Server", () => {
  let tmpDir: string;
  let server: ReturnType<typeof createServer>;
  let wss: WebSocketServer;
  let wsHandler: WebSocketHandler;
  let sessionManager: SessionManager;
  let baseUrl: string;
  let wsUrl: string;

  beforeAll(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "lliam-e2e-"));

    const storage = new FileSystemSessionStorage(tmpDir);
    sessionManager = new SessionManager(storage);

    const agentConfig: AgentConfig = {
      model: "claude-sonnet-4-20250514",
      temperature: 0.7,
      maxTokens: 4096,
      maxRetries: 1,
      retryDelayMs: 100,
    };

    const auth = new ApiKeyAuthenticator(TEST_API_KEY);

    wsHandler = new WebSocketHandler({
      sessionManager,
      agentConfig,
      auth,
      rateLimitPerMinute: 60,
    });

    const app = express();
    app.use(express.json());
    app.use(createRoutes(sessionManager));

    server = createServer(app);
    wss = new WebSocketServer({ noServer: true });

    server.on("upgrade", (req, socket, head) => {
      const url = new URL(req.url ?? "", `http://${req.headers.host}`);
      const apiKey = url.searchParams.get("apiKey") ?? undefined;

      wss.handleUpgrade(req, socket, head, (ws) => {
        wsHandler.handleConnection(ws, apiKey);
      });
    });

    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => {
        const addr = server.address();
        if (addr && typeof addr === "object") {
          baseUrl = `http://127.0.0.1:${addr.port}`;
          wsUrl = `ws://127.0.0.1:${addr.port}`;
        }
        resolve();
      });
    });
  });

  afterAll(async () => {
    wsHandler.closeAll();
    wss.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(tmpDir, { recursive: true, force: true });
  });

  // ─── REST API Tests ──────────────────────────────────────────────────────

  describe("REST API", () => {
    it("should return health status", async () => {
      const res = await fetch(`${baseUrl}/api/health`);
      const data = (await res.json()) as { ok: boolean; status: string };
      expect(res.status).toBe(200);
      expect(data.ok).toBe(true);
      expect(data.status).toBe("healthy");
    });

    it("should create and list sessions via REST", async () => {
      const createRes = await fetch(`${baseUrl}/api/sessions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "E2E Test Session" }),
      });
      const createData = (await createRes.json()) as {
        ok: boolean;
        sessionId: string;
        title: string;
      };
      expect(createRes.status).toBe(201);
      expect(createData.ok).toBe(true);
      expect(createData.title).toBe("E2E Test Session");

      const listRes = await fetch(`${baseUrl}/api/sessions`);
      const listData = (await listRes.json()) as {
        ok: boolean;
        sessions: Array<{ sessionId: string }>;
      };
      expect(listData.ok).toBe(true);
      expect(
        listData.sessions.some((s) => s.sessionId === createData.sessionId)
      ).toBe(true);

      const getRes = await fetch(
        `${baseUrl}/api/sessions/${createData.sessionId}`
      );
      const getData = (await getRes.json()) as {
        ok: boolean;
        session: { sessionId: string; title: string };
      };
      expect(getData.ok).toBe(true);
      expect(getData.session.title).toBe("E2E Test Session");

      const deleteRes = await fetch(
        `${baseUrl}/api/sessions/${createData.sessionId}`,
        { method: "DELETE" }
      );
      const deleteData = (await deleteRes.json()) as {
        ok: boolean;
        deleted: boolean;
      };
      expect(deleteData.ok).toBe(true);

      const getAfterDelete = await fetch(
        `${baseUrl}/api/sessions/${createData.sessionId}`
      );
      expect(getAfterDelete.status).toBe(404);
    });
  });

  // ─── WebSocket Tests ─────────────────────────────────────────────────────

  describe("WebSocket Protocol", () => {
    it("should reject unauthenticated connections", async () => {
      const ws = new WebSocket(`${wsUrl}/ws`);

      const closePromise = new Promise<{ code: number; reason: string }>(
        (resolve) => {
          ws.on("close", (code, reason) => {
            resolve({ code, reason: reason.toString() });
          });
        }
      );

      const msgPromise = new Promise<unknown>((resolve) => {
        ws.on("message", (data) => {
          resolve(JSON.parse(data.toString()));
        });
      });

      const [closeResult, errorMsg] = await Promise.all([
        closePromise,
        msgPromise,
      ]);

      expect(closeResult.code).toBe(4001);
      expect((errorMsg as { ok: boolean }).ok).toBe(false);
    });

    it("should accept authenticated connections and send welcome", async () => {
      const { ws, welcome } = await connectWs(
        `${wsUrl}/ws?apiKey=${TEST_API_KEY}`
      );

      expect(welcome).not.toBeNull();
      const msg = welcome as {
        type: string;
        ok: boolean;
        payload: { message: string };
      };
      expect(msg.type).toBe("response");
      expect(msg.ok).toBe(true);
      expect(msg.payload.message).toContain("Connected");

      ws.close();
    });

    it("should handle ping request", async () => {
      const { ws } = await connectWs(
        `${wsUrl}/ws?apiKey=${TEST_API_KEY}`
      );

      // Send ping
      ws.send(
        JSON.stringify({
          type: "request",
          requestId: "ping-1",
          method: "ping",
        })
      );

      const pong = (await waitForMessage(ws)) as {
        type: string;
        requestId: string;
        ok: boolean;
        payload: { pong: number };
      };

      expect(pong.type).toBe("response");
      expect(pong.requestId).toBe("ping-1");
      expect(pong.ok).toBe(true);
      expect(pong.payload.pong).toBeGreaterThan(0);

      ws.close();
    });

    it("should handle sessions.create via WebSocket", async () => {
      const { ws } = await connectWs(
        `${wsUrl}/ws?apiKey=${TEST_API_KEY}`
      );

      ws.send(
        JSON.stringify({
          type: "request",
          requestId: "create-1",
          method: "sessions.create",
          params: { title: "WS Session" },
        })
      );

      const response = (await waitForMessage(ws)) as {
        type: string;
        requestId: string;
        ok: boolean;
        payload: { sessionId: string; title: string };
      };

      expect(response.ok).toBe(true);
      expect(response.payload.title).toBe("WS Session");
      expect(response.payload.sessionId).toBeTruthy();

      ws.close();
    });

    it("should handle sessions.list via WebSocket", async () => {
      const { ws } = await connectWs(
        `${wsUrl}/ws?apiKey=${TEST_API_KEY}`
      );

      ws.send(
        JSON.stringify({
          type: "request",
          requestId: "list-1",
          method: "sessions.list",
        })
      );

      const response = (await waitForMessage(ws)) as {
        type: string;
        requestId: string;
        ok: boolean;
        payload: { sessions: unknown[] };
      };

      expect(response.ok).toBe(true);
      expect(Array.isArray(response.payload.sessions)).toBe(true);

      ws.close();
    });

    it("should reject invalid frames", async () => {
      const { ws } = await connectWs(
        `${wsUrl}/ws?apiKey=${TEST_API_KEY}`
      );

      ws.send("this is not json");

      const response = (await waitForMessage(ws)) as {
        type: string;
        ok: boolean;
        error: string;
      };

      expect(response.ok).toBe(false);
      expect(response.error).toContain("Invalid");

      ws.close();
    });

    it("should track connection count changes", async () => {
      // Wait for any stale close events from previous tests
      await new Promise((r) => setTimeout(r, 200));
      const baseline = wsHandler.getConnectionCount();

      const { ws: ws1 } = await connectWs(
        `${wsUrl}/ws?apiKey=${TEST_API_KEY}`
      );
      expect(wsHandler.getConnectionCount()).toBe(baseline + 1);

      const { ws: ws2 } = await connectWs(
        `${wsUrl}/ws?apiKey=${TEST_API_KEY}`
      );
      expect(wsHandler.getConnectionCount()).toBe(baseline + 2);

      // Close first connection and verify count decreases
      ws1.close();
      await new Promise((r) => setTimeout(r, 200));
      expect(wsHandler.getConnectionCount()).toBe(baseline + 1);

      // Close second connection
      ws2.close();
      await new Promise((r) => setTimeout(r, 200));
      expect(wsHandler.getConnectionCount()).toBe(baseline);
    });

    it("should broadcast heartbeat to all connections", async () => {
      const { ws: ws1 } = await connectWs(
        `${wsUrl}/ws?apiKey=${TEST_API_KEY}`
      );
      const { ws: ws2 } = await connectWs(
        `${wsUrl}/ws?apiKey=${TEST_API_KEY}`
      );

      const msg1Promise = waitForMessage(ws1);
      const msg2Promise = waitForMessage(ws2);
      wsHandler.broadcastHeartbeat(12345);

      const [hb1, hb2] = (await Promise.all([msg1Promise, msg2Promise])) as [
        { type: string; event: string; payload: { uptime: number } },
        { type: string; event: string; payload: { uptime: number } }
      ];

      expect(hb1.type).toBe("event");
      expect(hb1.event).toBe("heartbeat");
      expect(hb1.payload.uptime).toBe(12345);

      expect(hb2.type).toBe("event");
      expect(hb2.event).toBe("heartbeat");

      ws1.close();
      ws2.close();
    });

    it("should persist session data to disk", async () => {
      // Use the REST API to create a session and verify disk persistence
      const createRes = await fetch(`${baseUrl}/api/sessions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "Disk Persistence Test" }),
      });
      const createData = (await createRes.json()) as {
        ok: boolean;
        sessionId: string;
      };
      expect(createData.ok).toBe(true);

      // FileSystemSessionStorage stores files under baseDir/sessions/
      const sessionFile = join(
        tmpDir,
        "sessions",
        `${createData.sessionId}.json`
      );
      expect(existsSync(sessionFile)).toBe(true);
    });
  });
});
