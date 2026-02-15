/**
 * MemoryDatabase — SQLite connection, CRUD operations, migrations.
 *
 * Uses sql.js (pure WASM SQLite) for zero-native-dep portability.
 * Database persists to disk via manual save() calls using atomic writes.
 * FTS4 for keyword search, embeddings stored as BLOBs for in-process vector search.
 */

import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync } from "node:fs";
import { dirname } from "node:path";
import initSqlJs, { type SqlJsDatabase } from "sql.js";
import {
  DDL_STATEMENTS,
  SCHEMA_VERSION,
  type MemoryRecord,
  type CreateMemoryInput,
  type UpdateMemoryInput,
  type MemoryCategory,
  type SourceType,
  encodeEmbedding,
  decodeEmbedding,
} from "./schema.js";

export class MemoryDatabase {
  private db: SqlJsDatabase | null = null;
  private dbPath: string;
  private dirty = false;

  constructor(dbPath: string) {
    this.dbPath = dbPath;
  }

  /**
   * Initialize the database — load from disk or create new.
   */
  async open(): Promise<void> {
    const SQL = await initSqlJs();

    if (existsSync(this.dbPath)) {
      const buffer = readFileSync(this.dbPath);
      this.db = new SQL.Database(buffer);
    } else {
      mkdirSync(dirname(this.dbPath), { recursive: true });
      this.db = new SQL.Database();
    }

    // Enable WAL mode for better concurrent read performance
    this.db.run("PRAGMA journal_mode=WAL");
    this.db.run("PRAGMA foreign_keys=ON");

    // Run schema DDL
    for (const stmt of DDL_STATEMENTS) {
      this.db.run(stmt);
    }

    // Set schema version
    this.db.run(
      "INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', ?)",
      [String(SCHEMA_VERSION)]
    );

    this.dirty = true;
    this.save();
  }

  /**
   * Persist database to disk using atomic write (temp → rename).
   */
  save(): void {
    if (!this.db || !this.dirty) return;

    const data = this.db.export();
    const buffer = Buffer.from(data);
    const tmpPath = this.dbPath + ".tmp";

    mkdirSync(dirname(this.dbPath), { recursive: true });
    writeFileSync(tmpPath, buffer, { mode: 0o600 });
    renameSync(tmpPath, this.dbPath);
    this.dirty = false;
  }

  /**
   * Close the database, saving any pending changes.
   */
  close(): void {
    if (this.db) {
      this.save();
      this.db.close();
      this.db = null;
    }
  }

  private requireDb(): SqlJsDatabase {
    if (!this.db) throw new Error("MemoryDatabase not opened. Call open() first.");
    return this.db;
  }

  // ─── CREATE ────────────────────────────────────────────────────

  /**
   * Store a new memory. Returns the generated memory ID.
   */
  createMemory(input: CreateMemoryInput): string {
    const db = this.requireDb();
    const id = randomUUID();
    const now = Date.now();

    const embeddingBlob = input.embedding ? encodeEmbedding(input.embedding) : null;
    const embeddingDims = input.embedding ? input.embedding.length : null;
    const tags = JSON.stringify(input.tags ?? []);

    db.run(
      `INSERT INTO memories (
        id, category, content, embedding, embedding_model, embedding_dims,
        source_type, source_session, source_message_index,
        confidence, tags, created_at, updated_at, last_accessed_at, access_count
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
      [
        id,
        input.category ?? "other",
        input.content,
        embeddingBlob as unknown as string,
        input.embeddingModel ?? null,
        embeddingDims,
        input.sourceType ?? "manual",
        input.sourceSession ?? null,
        input.sourceMessageIndex ?? null,
        input.confidence ?? 1.0,
        tags,
        now,
        now,
        now,
      ]
    );

    // Sync FTS index
    db.run("INSERT INTO memories_fts (rowid, content) VALUES (last_insert_rowid(), ?)", [
      input.content,
    ]);

    this.dirty = true;
    return id;
  }

  // ─── READ ──────────────────────────────────────────────────────

  /**
   * Get a single memory by ID.
   */
  getMemory(id: string): MemoryRecord | null {
    const db = this.requireDb();

    // Check existence first
    const check = db.exec("SELECT COUNT(*) FROM memories WHERE id = ?", [id]);
    if (!check.length || (check[0].values[0]?.[0] as number) === 0) return null;

    // Update access tracking before reading
    db.run(
      "UPDATE memories SET last_accessed_at = ?, access_count = access_count + 1 WHERE id = ?",
      [Date.now(), id]
    );
    this.dirty = true;

    // Read with updated values
    const results = db.exec("SELECT * FROM memories WHERE id = ?", [id]);
    return this.rowToRecord(results[0].columns, results[0].values[0]);
  }

  /**
   * List memories with optional filters.
   */
  listMemories(opts?: {
    category?: MemoryCategory;
    sourceSession?: string;
    limit?: number;
    offset?: number;
    orderBy?: "created_at" | "updated_at" | "last_accessed_at" | "confidence";
    order?: "ASC" | "DESC";
  }): MemoryRecord[] {
    const db = this.requireDb();

    const conditions: string[] = [];
    const params: unknown[] = [];

    if (opts?.category) {
      conditions.push("category = ?");
      params.push(opts.category);
    }
    if (opts?.sourceSession) {
      conditions.push("source_session = ?");
      params.push(opts.sourceSession);
    }

    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    const orderBy = opts?.orderBy ?? "updated_at";
    const order = opts?.order ?? "DESC";
    const limit = opts?.limit ?? 100;
    const offset = opts?.offset ?? 0;

    const sql = `SELECT * FROM memories ${where} ORDER BY ${orderBy} ${order} LIMIT ? OFFSET ?`;
    params.push(limit, offset);

    const results = db.exec(sql, params as string[]);
    if (!results.length) return [];

    return results[0].values.map((row) => this.rowToRecord(results[0].columns, row));
  }

  /**
   * Count total memories, optionally filtered by category.
   */
  countMemories(category?: MemoryCategory): number {
    const db = this.requireDb();
    const sql = category
      ? "SELECT COUNT(*) FROM memories WHERE category = ?"
      : "SELECT COUNT(*) FROM memories";
    const params = category ? [category] : [];
    const results = db.exec(sql, params);
    return (results[0]?.values[0]?.[0] as number) ?? 0;
  }

  // ─── UPDATE ────────────────────────────────────────────────────

  /**
   * Update an existing memory.
   */
  updateMemory(id: string, input: UpdateMemoryInput): boolean {
    const db = this.requireDb();

    const sets: string[] = [];
    const params: unknown[] = [];

    if (input.content !== undefined) {
      sets.push("content = ?");
      params.push(input.content);
    }
    if (input.category !== undefined) {
      sets.push("category = ?");
      params.push(input.category);
    }
    if (input.embedding !== undefined) {
      sets.push("embedding = ?", "embedding_dims = ?");
      params.push(encodeEmbedding(input.embedding) as unknown as string, input.embedding.length);
    }
    if (input.embeddingModel !== undefined) {
      sets.push("embedding_model = ?");
      params.push(input.embeddingModel);
    }
    if (input.confidence !== undefined) {
      sets.push("confidence = ?");
      params.push(input.confidence);
    }
    if (input.tags !== undefined) {
      sets.push("tags = ?");
      params.push(JSON.stringify(input.tags));
    }

    if (sets.length === 0) return false;

    sets.push("updated_at = ?");
    params.push(Date.now());
    params.push(id);

    db.run(`UPDATE memories SET ${sets.join(", ")} WHERE id = ?`, params as string[]);

    // Update FTS if content changed
    if (input.content !== undefined) {
      // FTS4 doesn't support UPDATE directly — delete and re-insert
      // We need the rowid, which for FTS4 maps to the actual table rowid
      const rowResult = db.exec("SELECT rowid FROM memories WHERE id = ?", [id]);
      if (rowResult.length && rowResult[0].values.length) {
        const rowid = rowResult[0].values[0][0] as number;
        db.run("DELETE FROM memories_fts WHERE rowid = ?", [rowid]);
        db.run("INSERT INTO memories_fts (rowid, content) VALUES (?, ?)", [
          rowid,
          input.content,
        ]);
      }
    }

    this.dirty = true;
    return true;
  }

  // ─── DELETE ────────────────────────────────────────────────────

  /**
   * Delete a memory by ID. Returns true if found and deleted.
   */
  deleteMemory(id: string): boolean {
    const db = this.requireDb();

    // Get rowid for FTS cleanup
    const rowResult = db.exec("SELECT rowid FROM memories WHERE id = ?", [id]);
    if (!rowResult.length || !rowResult[0].values.length) return false;

    const rowid = rowResult[0].values[0][0] as number;

    db.run("DELETE FROM memories_fts WHERE rowid = ?", [rowid]);
    db.run("DELETE FROM memories WHERE id = ?", [id]);

    this.dirty = true;
    return true;
  }

  /**
   * Delete all memories in a session.
   */
  deleteBySession(sessionId: string): number {
    const db = this.requireDb();

    // Get all rowids for FTS cleanup
    const rowResults = db.exec("SELECT rowid FROM memories WHERE source_session = ?", [
      sessionId,
    ]);
    if (rowResults.length && rowResults[0].values.length) {
      for (const row of rowResults[0].values) {
        db.run("DELETE FROM memories_fts WHERE rowid = ?", [row[0] as number]);
      }
    }

    const countBefore = this.countMemories();
    db.run("DELETE FROM memories WHERE source_session = ?", [sessionId]);
    const countAfter = this.countMemories();

    this.dirty = true;
    return countBefore - countAfter;
  }

  // ─── SEARCH ────────────────────────────────────────────────────

  /**
   * Keyword search using FTS4. Returns memory IDs with BM25-approximated scores.
   */
  keywordSearch(
    query: string,
    limit: number = 20
  ): Array<{ id: string; score: number }> {
    const db = this.requireDb();

    // Tokenize and build FTS4 match expression
    const tokens = query
      .toLowerCase()
      .split(/\s+/)
      .filter((t) => t.length > 1)
      .map((t) => `"${t.replace(/"/g, "")}"`)
      .join(" ");

    if (!tokens) return [];

    try {
      // FTS4 with matchinfo for scoring
      const results = db.exec(
        `SELECT m.id, matchinfo(memories_fts, 'pcnalx') as mi
         FROM memories_fts
         JOIN memories m ON m.rowid = memories_fts.rowid
         WHERE memories_fts MATCH ?
         LIMIT ?`,
        [tokens, limit]
      );

      if (!results.length) return [];

      return results[0].values.map((row) => {
        const id = row[0] as string;
        const matchinfoRaw = row[1] as Uint8Array;
        const score = this.computeBM25Score(matchinfoRaw);
        return { id, score };
      });
    } catch {
      // FTS match syntax errors — return empty
      return [];
    }
  }

  /**
   * Get all memories with embeddings for in-process vector search.
   * Returns id + embedding pairs without loading full records.
   */
  getAllEmbeddings(): Array<{ id: string; embedding: Float32Array }> {
    const db = this.requireDb();
    const results = db.exec(
      "SELECT id, embedding FROM memories WHERE embedding IS NOT NULL"
    );
    if (!results.length) return [];

    return results[0].values
      .filter((row) => row[1] !== null)
      .map((row) => ({
        id: row[0] as string,
        embedding: decodeEmbedding(row[1] as Uint8Array),
      }));
  }

  /**
   * Get multiple memories by IDs.
   */
  getMemoriesByIds(ids: string[]): MemoryRecord[] {
    if (ids.length === 0) return [];
    const db = this.requireDb();

    const placeholders = ids.map(() => "?").join(",");
    const results = db.exec(`SELECT * FROM memories WHERE id IN (${placeholders})`, ids);
    if (!results.length) return [];

    return results[0].values.map((row) => this.rowToRecord(results[0].columns, row));
  }

  // ─── MAINTENANCE ───────────────────────────────────────────────

  /**
   * Rebuild the FTS index from scratch.
   */
  rebuildFtsIndex(): void {
    const db = this.requireDb();
    db.run("DELETE FROM memories_fts");
    db.run(
      "INSERT INTO memories_fts (rowid, content) SELECT rowid, content FROM memories"
    );
    this.dirty = true;
  }

  /**
   * Get database stats for monitoring.
   */
  getStats(): {
    totalMemories: number;
    withEmbeddings: number;
    byCategory: Record<string, number>;
    dbSizeBytes: number;
  } {
    const db = this.requireDb();

    const total = this.countMemories();

    const embResult = db.exec("SELECT COUNT(*) FROM memories WHERE embedding IS NOT NULL");
    const withEmbeddings = (embResult[0]?.values[0]?.[0] as number) ?? 0;

    const catResult = db.exec("SELECT category, COUNT(*) FROM memories GROUP BY category");
    const byCategory: Record<string, number> = {};
    if (catResult.length) {
      for (const row of catResult[0].values) {
        byCategory[row[0] as string] = row[1] as number;
      }
    }

    const exported = db.export();
    const dbSizeBytes = exported.length;

    return { totalMemories: total, withEmbeddings, byCategory, dbSizeBytes };
  }

  /**
   * Check if the database is open.
   */
  isOpen(): boolean {
    return this.db !== null;
  }

  // ─── INTERNALS ─────────────────────────────────────────────────

  /**
   * Compute a BM25-approximated score from FTS4 matchinfo('pcnalx') data.
   * This is a simplified BM25 approximation since FTS4 doesn't have native BM25.
   */
  private computeBM25Score(matchinfoRaw: Uint8Array): number {
    if (!matchinfoRaw || matchinfoRaw.length === 0) return 0;

    // matchinfo returns uint32 values packed as bytes
    const view = new DataView(
      matchinfoRaw.buffer,
      matchinfoRaw.byteOffset,
      matchinfoRaw.byteLength
    );
    const numInts = matchinfoRaw.byteLength / 4;
    const info: number[] = [];
    for (let i = 0; i < numInts; i++) {
      info.push(view.getUint32(i * 4, true)); // little-endian
    }

    // pcnalx format:
    // p = number of matchable phrases in query
    // c = number of columns in FTS table
    // n = total number of rows in FTS table
    // then for each phrase×column: a(avg tokens), l(tokens in this row), x(hits in this row, hits in all rows, docs with hit)
    const p = info[0]; // phrases
    const c = info[1]; // columns
    const n = info[2]; // total docs

    if (n === 0 || p === 0) return 0;

    const k1 = 1.2;
    const b = 0.75;
    let score = 0;

    for (let i = 0; i < p; i++) {
      for (let j = 0; j < c; j++) {
        const baseOffset = 3 + (i * c + j); // a values
        const avgTokens = info[baseOffset] || 1;
        const lOffset = 3 + p * c + (i * c + j); // l values
        const tokens = info[lOffset] || 1;
        const xBaseOffset = 3 + 2 * p * c + (i * c + j) * 3; // x values
        const hitsInRow = info[xBaseOffset] || 0;
        /* hitsTotal = info[xBaseOffset + 1] — available for advanced TF-IDF scoring */
        const docsWithHit = info[xBaseOffset + 2] || 0;

        if (hitsInRow === 0 || docsWithHit === 0) continue;

        // IDF
        const idf = Math.log((n - docsWithHit + 0.5) / (docsWithHit + 0.5) + 1);

        // TF with length normalization
        const tf = (hitsInRow * (k1 + 1)) / (hitsInRow + k1 * (1 - b + b * (tokens / avgTokens)));

        score += idf * tf;
      }
    }

    // Normalize to 0-1 range (approximate)
    return Math.min(1, score / (p * 5));
  }

  /**
   * Convert a raw SQL row to a MemoryRecord.
   */
  private rowToRecord(columns: string[], values: unknown[]): MemoryRecord {
    const row: Record<string, unknown> = {};
    for (let i = 0; i < columns.length; i++) {
      row[columns[i]] = values[i];
    }

    return {
      id: row.id as string,
      category: row.category as MemoryCategory,
      content: row.content as string,
      embedding: row.embedding ? Buffer.from(row.embedding as Uint8Array) : null,
      embeddingModel: row.embedding_model as string | null,
      embeddingDims: row.embedding_dims as number | null,
      sourceType: row.source_type as SourceType,
      sourceSession: row.source_session as string | null,
      sourceMessageIndex: row.source_message_index as number | null,
      confidence: row.confidence as number,
      tags: JSON.parse((row.tags as string) ?? "[]"),
      createdAt: row.created_at as number,
      updatedAt: row.updated_at as number,
      lastAccessedAt: row.last_accessed_at as number,
      accessCount: row.access_count as number,
    };
  }
}
