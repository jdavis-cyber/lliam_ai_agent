/**
 * Memory Database Schema — SQL DDL for memories, metadata, FTS4
 *
 * Design decisions:
 * - Uses sql.js (pure WASM SQLite) — no native compilation needed
 * - FTS4 for keyword search (FTS5 not available in default sql.js build)
 * - Vector search done in-process via cosine similarity on Float32Array blobs
 * - Embeddings stored as base64-encoded Float32Array buffers
 * - All data local-only — zero network, max PII/PHI protection
 */

export const SCHEMA_VERSION = 1;

/**
 * Core DDL statements executed on database initialization.
 * Order matters — foreign keys reference memories table.
 */
export const DDL_STATEMENTS: string[] = [
  // -- Schema version tracking --
  `CREATE TABLE IF NOT EXISTS meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  )`,

  // -- Core memories table --
  `CREATE TABLE IF NOT EXISTS memories (
    id TEXT PRIMARY KEY,
    category TEXT NOT NULL DEFAULT 'other',
    content TEXT NOT NULL,
    embedding BLOB,
    embedding_model TEXT,
    embedding_dims INTEGER,
    source_type TEXT NOT NULL DEFAULT 'manual',
    source_session TEXT,
    source_message_index INTEGER,
    confidence REAL NOT NULL DEFAULT 1.0,
    tags TEXT NOT NULL DEFAULT '[]',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    last_accessed_at INTEGER NOT NULL,
    access_count INTEGER NOT NULL DEFAULT 0
  )`,

  // -- FTS4 virtual table for keyword search --
  `CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts4(
    content,
    tokenize=unicode61
  )`,

  // -- Indexes --
  `CREATE INDEX IF NOT EXISTS idx_memories_category ON memories(category)`,
  `CREATE INDEX IF NOT EXISTS idx_memories_created ON memories(created_at)`,
  `CREATE INDEX IF NOT EXISTS idx_memories_updated ON memories(updated_at)`,
  `CREATE INDEX IF NOT EXISTS idx_memories_source_session ON memories(source_session)`,
  `CREATE INDEX IF NOT EXISTS idx_memories_confidence ON memories(confidence)`,
];

/**
 * Valid memory categories.
 * - preference: User preferences ("I prefer dark mode")
 * - fact: Factual information about user ("My SSN is..." would be blocked)
 * - decision: Decisions made ("We agreed to use TypeScript")
 * - entity: People, places, projects ("Alex works at Acme Corp")
 * - procedure: How-to knowledge ("To deploy, run npm run build")
 * - other: Uncategorized
 */
export const MEMORY_CATEGORIES = [
  "preference",
  "fact",
  "decision",
  "entity",
  "procedure",
  "other",
] as const;

export type MemoryCategory = (typeof MEMORY_CATEGORIES)[number];

/**
 * Source types for memory provenance tracking.
 * - manual: User explicitly stored via tool
 * - auto_capture: Extracted from conversation by capture hook
 * - import: Bulk imported from file
 */
export const SOURCE_TYPES = ["manual", "auto_capture", "import"] as const;

export type SourceType = (typeof SOURCE_TYPES)[number];

/**
 * Core memory record matching the `memories` table.
 */
export interface MemoryRecord {
  id: string;
  category: MemoryCategory;
  content: string;
  embedding: Buffer | null;
  embeddingModel: string | null;
  embeddingDims: number | null;
  sourceType: SourceType;
  sourceSession: string | null;
  sourceMessageIndex: number | null;
  confidence: number;
  tags: string[];
  createdAt: number;
  updatedAt: number;
  lastAccessedAt: number;
  accessCount: number;
}

/**
 * Input for creating a new memory. ID and timestamps are auto-generated.
 */
export interface CreateMemoryInput {
  content: string;
  category?: MemoryCategory;
  embedding?: Float32Array;
  embeddingModel?: string;
  sourceType?: SourceType;
  sourceSession?: string;
  sourceMessageIndex?: number;
  confidence?: number;
  tags?: string[];
}

/**
 * Input for updating an existing memory.
 */
export interface UpdateMemoryInput {
  content?: string;
  category?: MemoryCategory;
  embedding?: Float32Array;
  embeddingModel?: string;
  confidence?: number;
  tags?: string[];
}

/**
 * Search result from hybrid search.
 */
export interface MemorySearchResult {
  memory: MemoryRecord;
  score: number;
  matchType: "vector" | "keyword" | "hybrid";
}

/**
 * Encode a Float32Array embedding into a Buffer for SQLite BLOB storage.
 */
export function encodeEmbedding(embedding: Float32Array): Buffer {
  return Buffer.from(embedding.buffer, embedding.byteOffset, embedding.byteLength);
}

/**
 * Decode a Buffer from SQLite BLOB back into a Float32Array.
 */
export function decodeEmbedding(buffer: Buffer | Uint8Array): Float32Array {
  const arrayBuffer = buffer.buffer.slice(
    buffer.byteOffset,
    buffer.byteOffset + buffer.byteLength
  );
  return new Float32Array(arrayBuffer);
}
