import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, renameSync, unlinkSync, writeFileSync, readFileSync, chmodSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Message } from "../types/index.js";

// ─── Session Transcript Types ───────────────────────────────────────────────

export interface SessionTranscript {
  sessionId: string;
  title: string;
  created: number;
  modified: number;
  messageCount: number;
  messages: Message[];
}

export interface SessionSummary {
  sessionId: string;
  title: string;
  created: number;
  modified: number;
  messageCount: number;
  preview?: string;
}

// ─── Session Storage Interface ──────────────────────────────────────────────

export interface SessionStorage {
  createSession(title?: string): SessionTranscript;
  loadSession(sessionId: string): SessionTranscript | null;
  saveSession(transcript: SessionTranscript): void;
  deleteSession(sessionId: string): boolean;
  listSessions(): SessionSummary[];
  sessionExists(sessionId: string): boolean;
}

// ─── File System Implementation ─────────────────────────────────────────────

/**
 * Stores session transcripts as JSON files on disk.
 *
 * Security:
 * - Files written atomically (write to temp → rename) to prevent corruption
 * - File permissions set to 0600 (owner read/write only)
 * - Directory permissions set to 0700 (owner only)
 */
export class FileSystemSessionStorage implements SessionStorage {
  private dir: string;

  constructor(baseDataDir: string, sessionsSubdir: string = "sessions") {
    this.dir = join(baseDataDir, sessionsSubdir);
    this.ensureDirectory();
  }

  /**
   * Create a new empty session.
   */
  createSession(title?: string): SessionTranscript {
    const now = Date.now();
    const transcript: SessionTranscript = {
      sessionId: randomUUID(),
      title: title ?? `Session ${new Date(now).toLocaleDateString()}`,
      created: now,
      modified: now,
      messageCount: 0,
      messages: [],
    };

    this.saveSession(transcript);
    return transcript;
  }

  /**
   * Load a session transcript from disk.
   * Returns null if the session doesn't exist.
   */
  loadSession(sessionId: string): SessionTranscript | null {
    const filepath = this.sessionPath(sessionId);
    if (!existsSync(filepath)) return null;

    try {
      const raw = readFileSync(filepath, "utf-8");
      const parsed = JSON.parse(raw) as SessionTranscript;

      // Basic validation
      if (!parsed.sessionId || !parsed.messages) {
        return null;
      }

      return parsed;
    } catch {
      // Corrupted file — return null rather than crash
      return null;
    }
  }

  /**
   * Save a session transcript to disk atomically.
   *
   * Atomic write: write to a temp file first, then rename.
   * This prevents corruption if the process crashes mid-write.
   */
  saveSession(transcript: SessionTranscript): void {
    transcript.modified = Date.now();
    transcript.messageCount = transcript.messages.length;

    const filepath = this.sessionPath(transcript.sessionId);
    const tempPath = filepath + `.tmp.${Date.now()}`;

    const json = JSON.stringify(transcript, null, 2);

    // Write to temp file
    writeFileSync(tempPath, json, { encoding: "utf-8", mode: 0o600 });

    // Atomic rename
    renameSync(tempPath, filepath);
  }

  /**
   * Delete a session from disk.
   */
  deleteSession(sessionId: string): boolean {
    const filepath = this.sessionPath(sessionId);
    if (!existsSync(filepath)) return false;

    try {
      unlinkSync(filepath);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * List all sessions with summary metadata (no full message content).
   * Sorted by most recently modified first.
   */
  listSessions(): SessionSummary[] {
    if (!existsSync(this.dir)) return [];

    const files = readdirSync(this.dir).filter((f) => f.endsWith(".json"));
    const summaries: SessionSummary[] = [];

    for (const file of files) {
      try {
        const raw = readFileSync(join(this.dir, file), "utf-8");
        const parsed = JSON.parse(raw) as SessionTranscript;

        // Extract preview from last user message
        const lastUserMsg = [...parsed.messages]
          .reverse()
          .find((m) => m.role === "user");
        const preview = lastUserMsg
          ? lastUserMsg.content.substring(0, 100)
          : undefined;

        summaries.push({
          sessionId: parsed.sessionId,
          title: parsed.title,
          created: parsed.created,
          modified: parsed.modified,
          messageCount: parsed.messageCount,
          preview,
        });
      } catch {
        // Skip corrupted files
        continue;
      }
    }

    // Sort by most recently modified
    summaries.sort((a, b) => b.modified - a.modified);
    return summaries;
  }

  /**
   * Check if a session exists on disk.
   */
  sessionExists(sessionId: string): boolean {
    return existsSync(this.sessionPath(sessionId));
  }

  /**
   * Get the file path for a session ID.
   * Sanitizes the session ID to prevent path traversal attacks.
   */
  private sessionPath(sessionId: string): string {
    // Sanitize: only allow UUID characters (alphanumeric + hyphens)
    const sanitized = sessionId.replace(/[^a-zA-Z0-9-]/g, "");
    if (sanitized !== sessionId || sanitized.length === 0) {
      throw new Error(`Invalid session ID: ${sessionId}`);
    }
    return join(this.dir, `${sanitized}.json`);
  }

  /**
   * Ensure the sessions directory exists with correct permissions.
   */
  private ensureDirectory(): void {
    if (!existsSync(this.dir)) {
      mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    } else {
      // Verify permissions on existing directory
      try {
        const stats = statSync(this.dir);
        const mode = stats.mode & 0o777;
        if (mode !== 0o700) {
          chmodSync(this.dir, 0o700);
        }
      } catch {
        // Best effort — permission check may fail on some systems
      }
    }
  }
}
