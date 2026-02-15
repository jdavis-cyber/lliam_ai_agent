import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { FileSystemSessionStorage } from "../session/persistence.js";
import { SessionManager } from "../session/manager.js";

// ─── FileSystemSessionStorage Tests ─────────────────────────────────────────

describe("FileSystemSessionStorage", () => {
  let tempDir: string;
  let storage: FileSystemSessionStorage;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "lliam-test-"));
    storage = new FileSystemSessionStorage(tempDir);
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  describe("createSession", () => {
    it("should create a session with a UUID", () => {
      const session = storage.createSession();
      expect(session.sessionId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
      );
    });

    it("should create a session with default title", () => {
      const session = storage.createSession();
      expect(session.title).toContain("Session");
    });

    it("should create a session with custom title", () => {
      const session = storage.createSession("My Test Session");
      expect(session.title).toBe("My Test Session");
    });

    it("should persist session to disk", () => {
      const session = storage.createSession();
      const filepath = join(tempDir, "sessions", `${session.sessionId}.json`);
      expect(existsSync(filepath)).toBe(true);
    });

    it("should set timestamps", () => {
      const before = Date.now();
      const session = storage.createSession();
      const after = Date.now();
      expect(session.created).toBeGreaterThanOrEqual(before);
      expect(session.created).toBeLessThanOrEqual(after);
    });
  });

  describe("loadSession", () => {
    it("should load a previously created session", () => {
      const created = storage.createSession("Test");
      const loaded = storage.loadSession(created.sessionId);
      expect(loaded).not.toBeNull();
      expect(loaded!.sessionId).toBe(created.sessionId);
      expect(loaded!.title).toBe("Test");
    });

    it("should return null for non-existent session", () => {
      const loaded = storage.loadSession("non-existent-id");
      expect(loaded).toBeNull();
    });
  });

  describe("saveSession", () => {
    it("should update session with messages", () => {
      const session = storage.createSession();
      session.messages.push({
        role: "user",
        content: "Hello",
        timestamp: Date.now(),
      });
      storage.saveSession(session);

      const loaded = storage.loadSession(session.sessionId);
      expect(loaded!.messages).toHaveLength(1);
      expect(loaded!.messages[0].content).toBe("Hello");
      expect(loaded!.messageCount).toBe(1);
    });

    it("should perform atomic writes (temp file should not persist)", () => {
      const session = storage.createSession();
      session.messages.push({
        role: "user",
        content: "Test atomic",
        timestamp: Date.now(),
      });
      storage.saveSession(session);

      // Check no .tmp files remain
      const sessionsDir = join(tempDir, "sessions");
      const files = require("node:fs").readdirSync(sessionsDir) as string[];
      const tmpFiles = files.filter((f: string) => f.includes(".tmp"));
      expect(tmpFiles).toHaveLength(0);
    });
  });

  describe("deleteSession", () => {
    it("should delete an existing session", () => {
      const session = storage.createSession();
      const deleted = storage.deleteSession(session.sessionId);
      expect(deleted).toBe(true);
      expect(storage.loadSession(session.sessionId)).toBeNull();
    });

    it("should return false for non-existent session", () => {
      const deleted = storage.deleteSession("non-existent");
      expect(deleted).toBe(false);
    });
  });

  describe("listSessions", () => {
    it("should list all sessions sorted by modified date", () => {
      // Mock Date.now to return incrementing values so saveSession gets distinct timestamps
      let mockTime = 1000;
      const spy = vi.spyOn(Date, "now").mockImplementation(() => mockTime);

      storage.createSession("First");
      mockTime = 2000;
      storage.createSession("Second");
      mockTime = 3000;
      storage.createSession("Third");

      spy.mockRestore();

      const list = storage.listSessions();
      expect(list).toHaveLength(3);
      // Most recent first
      expect(list[0].title).toBe("Third");
      expect(list[1].title).toBe("Second");
      expect(list[2].title).toBe("First");
    });

    it("should return empty array when no sessions", () => {
      const list = storage.listSessions();
      expect(list).toHaveLength(0);
    });

    it("should include preview from last user message", () => {
      const session = storage.createSession();
      session.messages.push({
        role: "user",
        content: "What is AI governance?",
        timestamp: Date.now(),
      });
      storage.saveSession(session);

      const list = storage.listSessions();
      expect(list[0].preview).toBe("What is AI governance?");
    });
  });

  describe("sessionExists", () => {
    it("should return true for existing session", () => {
      const session = storage.createSession();
      expect(storage.sessionExists(session.sessionId)).toBe(true);
    });

    it("should return false for non-existent session", () => {
      expect(storage.sessionExists("fake-id")).toBe(false);
    });
  });

  describe("security", () => {
    it("should reject session IDs with path traversal characters", () => {
      expect(() => storage.loadSession("../../../etc/passwd")).toThrow(
        "Invalid session ID"
      );
    });

    it("should reject session IDs with special characters", () => {
      expect(() => storage.loadSession("id;rm -rf /")).toThrow(
        "Invalid session ID"
      );
    });
  });
});

// ─── SessionManager Tests ───────────────────────────────────────────────────

describe("SessionManager", () => {
  let tempDir: string;
  let storage: FileSystemSessionStorage;
  let manager: SessionManager;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "lliam-mgr-test-"));
    storage = new FileSystemSessionStorage(tempDir);
    manager = new SessionManager(storage);
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  describe("createSession", () => {
    it("should create and cache a session", () => {
      const session = manager.createSession("Test");
      expect(session.title).toBe("Test");
      expect(manager.sessionExists(session.sessionId)).toBe(true);
    });
  });

  describe("getSession", () => {
    it("should return session from cache on second access", () => {
      const created = manager.createSession();
      const fetched = manager.getSession(created.sessionId);
      expect(fetched).not.toBeNull();
      expect(fetched!.sessionId).toBe(created.sessionId);
    });

    it("should load from disk if not in cache", () => {
      const session = storage.createSession("Disk Session");
      // New manager with empty cache
      const freshManager = new SessionManager(storage);
      const loaded = freshManager.getSession(session.sessionId);
      expect(loaded).not.toBeNull();
      expect(loaded!.title).toBe("Disk Session");
    });

    it("should return null for non-existent session", () => {
      expect(manager.getSession("fake")).toBeNull();
    });
  });

  describe("addMessage", () => {
    it("should add a message and persist", async () => {
      const session = manager.createSession();
      await manager.addMessage(session.sessionId, {
        role: "user",
        content: "Hello Lliam",
        timestamp: Date.now(),
      });

      const history = manager.getHistory(session.sessionId);
      expect(history).toHaveLength(1);
      expect(history[0].content).toBe("Hello Lliam");

      // Verify persisted to disk
      const loaded = storage.loadSession(session.sessionId);
      expect(loaded!.messages).toHaveLength(1);
    });

    it("should maintain message order", async () => {
      const session = manager.createSession();
      await manager.addMessage(session.sessionId, {
        role: "user",
        content: "First",
        timestamp: Date.now(),
      });
      await manager.addMessage(session.sessionId, {
        role: "assistant",
        content: "Second",
        timestamp: Date.now(),
      });

      const history = manager.getHistory(session.sessionId);
      expect(history[0].content).toBe("First");
      expect(history[1].content).toBe("Second");
    });
  });

  describe("clearSession", () => {
    it("should clear all messages", async () => {
      const session = manager.createSession();
      await manager.addMessage(session.sessionId, {
        role: "user",
        content: "Test",
        timestamp: Date.now(),
      });

      const cleared = await manager.clearSession(session.sessionId);
      expect(cleared).toBe(true);
      expect(manager.getHistory(session.sessionId)).toHaveLength(0);
    });

    it("should return false for non-existent session", async () => {
      const cleared = await manager.clearSession("fake");
      expect(cleared).toBe(false);
    });
  });

  describe("deleteSession", () => {
    it("should delete session from cache and disk", () => {
      const session = manager.createSession();
      const deleted = manager.deleteSession(session.sessionId);
      expect(deleted).toBe(true);
      expect(manager.getSession(session.sessionId)).toBeNull();
    });
  });

  describe("listSessions", () => {
    it("should list all sessions", () => {
      manager.createSession("A");
      manager.createSession("B");
      const list = manager.listSessions();
      expect(list).toHaveLength(2);
    });
  });
});
