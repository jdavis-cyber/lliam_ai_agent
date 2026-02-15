/**
 * MemoryManager — Coordinates all memory system components.
 *
 * Single entry point for:
 * - Database lifecycle (open/close/save)
 * - Embedding provider initialization
 * - Hybrid search
 * - Auto-capture from conversations
 * - Auto-recall into agent context
 * - Manual memory CRUD
 *
 * This is the class that plugins and the agent-runner interact with.
 */

import { join } from "node:path";
import { MemoryDatabase } from "./db.js";
import {
  type EmbeddingProvider,
  SimpleHashEmbeddingProvider,
} from "./embeddings.js";
import { HybridSearcher, type SearchOptions } from "./search.js";
import { MemoryCapture, type CaptureConfig, DEFAULT_CAPTURE_CONFIG } from "./capture.js";
import { MemoryRecaller, type RecallConfig, DEFAULT_RECALL_CONFIG } from "./recall.js";
import type {
  MemoryRecord,
  CreateMemoryInput,
  UpdateMemoryInput,
  MemoryCategory,
  MemorySearchResult,
} from "./schema.js";

/**
 * Full memory system configuration.
 */
export interface MemoryConfig {
  /** Path to the SQLite database file */
  dbPath: string;
  /** Embedding provider instance (or 'auto' to use SimpleHash for dev) */
  embedder?: EmbeddingProvider;
  /** Auto-capture configuration */
  capture?: Partial<CaptureConfig>;
  /** Auto-recall configuration */
  recall?: Partial<RecallConfig>;
}

export class MemoryManager {
  private db: MemoryDatabase;
  private embedder: EmbeddingProvider;
  private searcher!: HybridSearcher;
  private capturer!: MemoryCapture;
  private recaller!: MemoryRecaller;
  private initialized = false;
  private captureConfig: CaptureConfig;
  private recallConfig: RecallConfig;

  constructor(config: MemoryConfig) {
    this.db = new MemoryDatabase(config.dbPath);
    this.embedder = config.embedder ?? new SimpleHashEmbeddingProvider();
    this.captureConfig = { ...DEFAULT_CAPTURE_CONFIG, ...config.capture };
    this.recallConfig = { ...DEFAULT_RECALL_CONFIG, ...config.recall };
  }

  /**
   * Initialize all components. Must be called before any other method.
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;

    // Open database
    await this.db.open();

    // Initialize embedding provider
    await this.embedder.initialize();

    // Wire up components
    this.searcher = new HybridSearcher(this.db, this.embedder);
    this.capturer = new MemoryCapture(this.db, this.embedder, this.captureConfig);
    this.recaller = new MemoryRecaller(this.searcher, this.recallConfig);

    this.initialized = true;
  }

  /**
   * Shut down: save DB, release embedder.
   */
  async shutdown(): Promise<void> {
    if (!this.initialized) return;

    this.db.close();
    await this.embedder.dispose();
    this.initialized = false;
  }

  // ─── CRUD Operations ──────────────────────────────────────────

  /**
   * Store a new memory with optional auto-embedding.
   */
  async store(input: CreateMemoryInput): Promise<string> {
    this.requireInitialized();

    // Auto-generate embedding if not provided
    if (!input.embedding) {
      try {
        const embedding = await this.embedder.embed(input.content);
        input = {
          ...input,
          embedding,
          embeddingModel: this.embedder.modelName,
        };
      } catch (err) {
        console.warn("[memory:manager] Failed to generate embedding:", err);
        // Store without embedding — keyword search still works
      }
    }

    const id = this.db.createMemory(input);
    this.db.save();
    return id;
  }

  /**
   * Get a memory by ID.
   */
  get(id: string): MemoryRecord | null {
    this.requireInitialized();
    return this.db.getMemory(id);
  }

  /**
   * List memories with optional filters.
   */
  list(opts?: {
    category?: MemoryCategory;
    sourceSession?: string;
    limit?: number;
    offset?: number;
  }): MemoryRecord[] {
    this.requireInitialized();
    return this.db.listMemories(opts);
  }

  /**
   * Update an existing memory.
   */
  async update(id: string, input: UpdateMemoryInput): Promise<boolean> {
    this.requireInitialized();

    // Re-generate embedding if content changed
    if (input.content && !input.embedding) {
      try {
        input.embedding = await this.embedder.embed(input.content);
        input.embeddingModel = this.embedder.modelName;
      } catch {
        // Update without new embedding
      }
    }

    const result = this.db.updateMemory(id, input);
    if (result) this.db.save();
    return result;
  }

  /**
   * Delete a memory by ID.
   */
  delete(id: string): boolean {
    this.requireInitialized();
    const result = this.db.deleteMemory(id);
    if (result) this.db.save();
    return result;
  }

  /**
   * Count memories.
   */
  count(category?: MemoryCategory): number {
    this.requireInitialized();
    return this.db.countMemories(category);
  }

  // ─── Search ───────────────────────────────────────────────────

  /**
   * Hybrid search across memories.
   */
  async search(query: string, opts?: SearchOptions): Promise<MemorySearchResult[]> {
    this.requireInitialized();
    return this.searcher.search(query, opts);
  }

  // ─── Auto-Capture (agent_end hook) ────────────────────────────

  /**
   * Extract and store memories from a conversation exchange.
   * Called by the agent_end hook.
   */
  async captureFromConversation(
    userMessage: string,
    assistantMessage: string,
    sessionId: string,
    extractFn: (prompt: string) => Promise<string>
  ): Promise<string[]> {
    this.requireInitialized();

    const ids = await this.capturer.captureFromConversation(
      userMessage,
      assistantMessage,
      sessionId,
      extractFn
    );

    if (ids.length > 0) {
      this.db.save();
    }

    return ids;
  }

  // ─── Auto-Recall (before_agent_start hook) ────────────────────

  /**
   * Find relevant memories for context injection.
   * Called by the before_agent_start hook.
   */
  async recall(userMessage: string): Promise<{
    memories: MemorySearchResult[];
    contextBlock: string;
  }> {
    this.requireInitialized();
    return this.recaller.recall(userMessage);
  }

  // ─── Stats & Maintenance ──────────────────────────────────────

  /**
   * Get database statistics.
   */
  getStats() {
    this.requireInitialized();
    return this.db.getStats();
  }

  /**
   * Re-embed all memories (e.g., after changing embedding model).
   */
  async reembedAll(batchSize: number = 50): Promise<{
    total: number;
    succeeded: number;
    failed: number;
  }> {
    this.requireInitialized();

    const memories = this.db.listMemories({ limit: 10000 });
    let succeeded = 0;
    let failed = 0;

    for (let i = 0; i < memories.length; i += batchSize) {
      const batch = memories.slice(i, i + batchSize);
      const texts = batch.map((m) => m.content);

      try {
        const embeddings = await this.embedder.embedBatch(texts);
        for (let j = 0; j < batch.length; j++) {
          this.db.updateMemory(batch[j].id, {
            embedding: embeddings[j],
            embeddingModel: this.embedder.modelName,
          });
          succeeded++;
        }
      } catch (err) {
        console.error(`[memory:manager] Batch re-embed failed at offset ${i}:`, err);
        failed += batch.length;
      }
    }

    this.db.save();
    return { total: memories.length, succeeded, failed };
  }

  /**
   * Rebuild the FTS index.
   */
  rebuildIndex(): void {
    this.requireInitialized();
    this.db.rebuildFtsIndex();
    this.db.save();
  }

  /**
   * Check if the manager is initialized.
   */
  isInitialized(): boolean {
    return this.initialized;
  }

  /**
   * Get the underlying database (for advanced use / testing).
   */
  getDatabase(): MemoryDatabase {
    return this.db;
  }

  /**
   * Get the embedding provider (for advanced use / testing).
   */
  getEmbedder(): EmbeddingProvider {
    return this.embedder;
  }

  private requireInitialized(): void {
    if (!this.initialized) {
      throw new Error("MemoryManager not initialized. Call initialize() first.");
    }
  }
}

/**
 * Create a default MemoryManager with standard configuration.
 * Uses ~/.lliam/memory.db as the database path.
 */
export function createDefaultMemoryManager(
  dataDir: string,
  embedder?: EmbeddingProvider
): MemoryManager {
  return new MemoryManager({
    dbPath: join(dataDir, "memory.db"),
    embedder,
  });
}
