/**
 * Session Persistence — encrypted file-system storage for session transcripts.
 *
 * Security (R-01 — NIST SP 800-53 SC-28):
 * - Each session JSON is encrypted with AES-256-GCM via KeyManager before write.
 * - Files written atomically (write to temp → rename) to prevent corruption.
 * - File permissions set to 0600 (owner read/write only).
 * - Directory permissions set to 0700 (owner only).
 * - Auto-migration: legacy plaintext .json files are re-encrypted on first read.
 */

import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
  readFileSync,
  chmodSync,
  statSync,
} from "node:fs";
import { join } from "node:path";
import type { Message } from "../types/index.js";
import { keyManager } from "../security/key-manager.js";

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
 * Stores session transcripts as AES-256-GCM encrypted files on disk.
 *
 * File layout on disk: [ version:1 | iv:12 | authTag:16 | encrypted JSON ]
 * If KeyManager is not ready (not initialized), falls back to plaintext with
 * a console warning — this should not happen in production where runner-factory
 * always calls keyManager.init() before constructing storage.
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
   * Load a session transcript from disk, decrypting if necessary.
   * Auto-migrates legacy plaintext files to encrypted on first read.
   * Returns null if the session doesn't exist.
   */
  loadSession(sessionId: string): SessionTranscript | null {
    const filepath = this.sessionPath(sessionId);
    if (!existsSync(filepath)) return null;

    try {
      const rawBuffer = readFileSync(filepath);

      let json: string;

      if (keyManager.isReady() && keyManager.isEncrypted(rawBuffer)) {
        // Normal path: decrypt
        const plainBuffer = keyManager.decrypt(rawBuffer);
        json = plainBuffer.toString("utf-8");
      } else if (keyManager.isReady() && !keyManager.isEncrypted(rawBuffer)) {
        // Migration path: legacy plaintext file — re-encrypt and save
        json = rawBuffer.toString("utf-8");
        console.warn(`  Session ${sessionId}: migrating plaintext file to encrypted storage.`);
        const encrypted = keyManager.encrypt(Buffer.from(json, "utf-8"));
        const tmpPath = filepath + `.tmp.${Date.now()}`;
        writeFileSync(tmpPath, encrypted, { mode: 0o600 });
        renameSync(tmpPath, filepath);
      } else {
        // KeyManager not ready — read plaintext (startup edge case only)
        json = rawBuffer.toString("utf-8");
      }

      const parsed = JSON.parse(json) as SessionTranscript;

      // Basic validation
      if (!parsed.sessionId || !parsed.messages) {
        return null;
      }

      return parsed;
    } catch {
      // Corrupted or tampered file — return null rather than crash
      return null;
    }
  }

  /**
   * Save a session transcript to disk — encrypted and atomic.
   */
  saveSession(transcript: SessionTranscript): void {
    transcript.modified = Date.now();
    transcript.messageCount = transcript.messages.length;

    const filepath = this.sessionPath(transcript.sessionId);
    const tempPath = filepath + `.tmp.${Date.now()}`;
    const json = JSON.stringify(transcript, null, 2);

    let dataToWrite: Buffer;

    if (keyManager.isReady()) {
      dataToWrite = keyManager.encrypt(Buffer.from(json, "utf-8"));
    } else {
      // Fallback: plaintext (should not happen in production)
      console.warn("  KeyManager not initialized — session written as plaintext.");
      dataToWrite = Buffer.from(json, "utf-8");
    }

    writeFileSync(tempPath, dataToWrite, { mode: 0o600 });
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
   * Sorted by most recently modified first. Reads and decrypts each file.
   */
  listSessions(): SessionSummary[] {
    if (!existsSync(this.dir)) return [];

    const files = readdirSync(this.dir).filter((f) => f.endsWith(".json"));
    const summaries: SessionSummary[] = [];

    for (const file of files) {
      try {
        const sessionId = file.replace(".json", "");
        const transcript = this.loadSession(sessionId);
        if (!transcript) continue;

        const lastUserMsg = [...transcript.messages]
          .reverse()
          .find((m) => m.role === "user");
        const preview = lastUserMsg
          ? lastUserMsg.content.substring(0, 100)
          : undefined;

        summaries.push({
          sessionId: transcript.sessionId,
          title: transcript.title,
          created: transcript.created,
          modified: transcript.modified,
          messageCount: transcript.messageCount,
          preview,
        });
      } catch {
        continue;
      }
    }

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
      try {
        const stats = statSync(this.dir);
        const mode = stats.mode & 0o777;
        if (mode !== 0o700) {
          chmodSync(this.dir, 0o700);
        }
      } catch {
        // Best effort
      }
    }
  }
}
