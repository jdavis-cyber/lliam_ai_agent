import type { Message } from "../types/index.js";
import type {
  SessionStorage,
  SessionTranscript,
  SessionSummary,
} from "./persistence.js";

// ─── Session Manager ────────────────────────────────────────────────────────

/**
 * Manages active sessions in memory with disk-backed persistence.
 *
 * - Keeps recently accessed sessions in an LRU-style cache
 * - Persists all changes to disk immediately (no lazy writes)
 * - Provides session locking to prevent concurrent mutations
 */
export class SessionManager {
  private storage: SessionStorage;
  private cache: Map<string, SessionTranscript>;
  private locks: Set<string>;
  private maxCacheSize: number;

  constructor(storage: SessionStorage, maxCacheSize: number = 20) {
    this.storage = storage;
    this.cache = new Map();
    this.locks = new Set();
    this.maxCacheSize = maxCacheSize;
  }

  /**
   * Create a new session.
   */
  createSession(title?: string): SessionTranscript {
    const transcript = this.storage.createSession(title);
    this.cacheSet(transcript.sessionId, transcript);
    return transcript;
  }

  /**
   * Get a session by ID. Loads from disk if not in cache.
   */
  getSession(sessionId: string): SessionTranscript | null {
    // Check cache first
    const cached = this.cache.get(sessionId);
    if (cached) return cached;

    // Load from disk
    const transcript = this.storage.loadSession(sessionId);
    if (transcript) {
      this.cacheSet(sessionId, transcript);
    }
    return transcript;
  }

  /**
   * Add a message to a session and persist immediately.
   * Creates the session if it doesn't exist.
   */
  async addMessage(
    sessionId: string,
    message: Message
  ): Promise<SessionTranscript> {
    // Acquire lock
    await this.acquireLock(sessionId);

    try {
      let transcript = this.getSession(sessionId);
      if (!transcript) {
        transcript = this.createSession();
        // Remap the ID if a specific one was requested
        if (sessionId !== transcript.sessionId) {
          transcript = this.storage.createSession();
        }
      }

      transcript.messages.push(message);
      this.storage.saveSession(transcript);
      this.cacheSet(transcript.sessionId, transcript);

      return transcript;
    } finally {
      this.releaseLock(sessionId);
    }
  }

  /**
   * Get the message history for a session.
   */
  getHistory(sessionId: string): Message[] {
    const transcript = this.getSession(sessionId);
    return transcript ? [...transcript.messages] : [];
  }

  /**
   * Clear all messages from a session (reset).
   */
  async clearSession(sessionId: string): Promise<boolean> {
    await this.acquireLock(sessionId);

    try {
      const transcript = this.getSession(sessionId);
      if (!transcript) return false;

      transcript.messages = [];
      transcript.messageCount = 0;
      this.storage.saveSession(transcript);
      this.cacheSet(sessionId, transcript);
      return true;
    } finally {
      this.releaseLock(sessionId);
    }
  }

  /**
   * Delete a session entirely.
   */
  deleteSession(sessionId: string): boolean {
    this.cache.delete(sessionId);
    return this.storage.deleteSession(sessionId);
  }

  /**
   * List all sessions (summaries only).
   */
  listSessions(): SessionSummary[] {
    return this.storage.listSessions();
  }

  /**
   * Check if a session exists.
   */
  sessionExists(sessionId: string): boolean {
    return this.cache.has(sessionId) || this.storage.sessionExists(sessionId);
  }

  // ─── Internal Helpers ───────────────────────────────────────────────────

  /**
   * Simple lock to prevent concurrent writes to the same session.
   * Polls with a short delay — sufficient for single-user local use.
   */
  private async acquireLock(
    sessionId: string,
    timeoutMs: number = 5000
  ): Promise<void> {
    const start = Date.now();
    while (this.locks.has(sessionId)) {
      if (Date.now() - start > timeoutMs) {
        throw new Error(
          `Timeout acquiring lock for session ${sessionId}. Another operation may be in progress.`
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    this.locks.add(sessionId);
  }

  private releaseLock(sessionId: string): void {
    this.locks.delete(sessionId);
  }

  /**
   * Add to cache with LRU eviction.
   */
  private cacheSet(sessionId: string, transcript: SessionTranscript): void {
    // Delete first to reset insertion order (Map preserves insertion order)
    this.cache.delete(sessionId);
    this.cache.set(sessionId, transcript);

    // Evict oldest if over capacity
    if (this.cache.size > this.maxCacheSize) {
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) {
        this.cache.delete(oldest);
      }
    }
  }
}
