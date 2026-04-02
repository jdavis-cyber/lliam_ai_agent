/**
 * AuditLogger — Durable append-only tool execution audit log.
 *
 * R-07 (NIST SP 800-53 AU-9, AU-11): Persists tool execution records to an
 * append-only JSON Lines file on disk so audit evidence survives process restarts.
 *
 * R-10 (NIST SP 800-53 AU-3, AU-9): Tool call parameters are never logged in
 * full. Instead, a SHA-256 hash of the canonical JSON representation is stored.
 * This prevents PII exposure in logs while preserving audit traceability
 * (the same params always produce the same hash, so replays are detectable).
 *
 * File layout:
 *   ~/.lliam/audit/tool-calls-{YYYY-MM}.jsonl   — active month
 *   ~/.lliam/audit/archive/tool-calls-{YYYY-MM}.jsonl — rotated months
 *
 * Each line is a valid JSON object (JSON Lines format):
 *   { "timestamp": 1234567890, "sessionId": "...", "toolName": "...",
 *     "toolCallId": "...", "params_hash": "sha256:abc...", "durationMs": 42,
 *     "blocked": false, "blockReason": null, "error": null }
 *
 * Rotation: on each write, if the current month has changed since the last
 * write, the old file is moved to archive/ and a new file is started.
 *
 * Governance alignment:
 *   NIST SP 800-53: AU-2 (audit events), AU-3 (content), AU-9 (protection),
 *                   AU-11 (retention), AU-14 (session audit)
 *   ISO 42001: Clause 7.5, 9.1
 *   CSRMC: AEP (Audit Evidence Package)
 */

import { createHash } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  renameSync,
} from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { ToolExecutionLog } from "../core/tool-executor.js";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface AuditEntry {
  timestamp: number;
  sessionId: string;
  toolName: string;
  toolCallId: string;
  /** SHA-256 hash of canonical JSON of params — never the raw params */
  params_hash: string;
  durationMs: number;
  blocked: boolean;
  blockReason: string | null;
  error: string | null;
}

// ─── AuditLogger ─────────────────────────────────────────────────────────────

export class AuditLogger {
  private auditDir: string;
  private archiveDir: string;
  private currentMonth: string;

  constructor(baseDir?: string) {
    this.auditDir = baseDir ?? join(homedir(), ".lliam", "audit");
    this.archiveDir = join(this.auditDir, "archive");
    this.currentMonth = this.monthKey(Date.now());
    this.ensureDirectories();
  }

  /**
   * Write a ToolExecutionLog entry to the durable audit log.
   * Parameters are hashed (SHA-256) — never written in plaintext.
   * Automatically rotates to archive if the calendar month has changed.
   */
  log(entry: ToolExecutionLog, sessionId: string): void {
    const now = Date.now();
    const month = this.monthKey(now);

    // Rotate if month changed
    if (month !== this.currentMonth) {
      this.rotateIfNeeded(this.currentMonth);
      this.currentMonth = month;
    }

    const auditEntry: AuditEntry = {
      timestamp: entry.timestamp,
      sessionId,
      toolName: entry.toolName,
      toolCallId: entry.toolCallId,
      params_hash: this.hashParams(entry.params),
      durationMs: entry.durationMs,
      blocked: entry.blocked,
      blockReason: entry.blockReason ?? null,
      error: entry.error ?? null,
    };

    const line = JSON.stringify(auditEntry) + "\n";
    const filepath = this.logPath(month);

    // appendFileSync is atomic for single writes < PIPE_BUF (~4KB) on Linux/macOS
    appendFileSync(filepath, line, { encoding: "utf-8", mode: 0o600, flag: "a" });
  }

  /**
   * Get the path to the current month's log file.
   */
  currentLogPath(): string {
    return this.logPath(this.currentMonth);
  }

  // ─── Internals ──────────────────────────────────────────────────────────

  /**
   * SHA-256 hash of canonical JSON of params object.
   * Canonical = keys sorted alphabetically for determinism.
   */
  private hashParams(params: Record<string, unknown>): string {
    const canonical = JSON.stringify(params, Object.keys(params).sort());
    return "sha256:" + createHash("sha256").update(canonical, "utf-8").digest("hex");
  }

  private monthKey(ts: number): string {
    const d = new Date(ts);
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    return `${y}-${m}`;
  }

  private logPath(month: string): string {
    return join(this.auditDir, `tool-calls-${month}.jsonl`);
  }

  private archivePath(month: string): string {
    return join(this.archiveDir, `tool-calls-${month}.jsonl`);
  }

  private rotateIfNeeded(month: string): void {
    const src = this.logPath(month);
    if (!existsSync(src)) return;

    const dst = this.archivePath(month);
    try {
      renameSync(src, dst);
    } catch {
      // Best effort — rotation failure should not crash the process
    }
  }

  private ensureDirectories(): void {
    if (!existsSync(this.auditDir)) {
      mkdirSync(this.auditDir, { recursive: true, mode: 0o700 });
    }
    if (!existsSync(this.archiveDir)) {
      mkdirSync(this.archiveDir, { recursive: true, mode: 0o700 });
    }
  }
}

// ─── Singleton ────────────────────────────────────────────────────────────────

export const auditLogger = new AuditLogger();
