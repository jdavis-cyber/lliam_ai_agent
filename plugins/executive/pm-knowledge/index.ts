/**
 * PM Knowledge Base Plugin
 *
 * Indexes an organization's licensed PM standards library (PDFs, Markdown, text)
 * into local encrypted vector storage for semantic retrieval during PM tasks.
 *
 * Ships with a built-in PMI ontology covering PMBOK process groups, knowledge
 * areas, risk categories, stakeholder engagement levels, and EVM formulas.
 *
 * Storage: sql.js (WASM SQLite) encrypted with AES-256-GCM via KeyManager.
 * Embeddings: Transformers.js (all-MiniLM-L6-v2) — on-device, zero API cost.
 *
 * Registered as service "pm-knowledge" so pm-documents and pm-risk can depend on it.
 */

import { readFileSync, readdirSync, statSync, mkdirSync, writeFileSync, renameSync, existsSync } from "node:fs";
import { join, extname, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import initSqlJs, { type SqlJsDatabase, type SqlValue } from "sql.js";
import { keyManager } from "../../../src/security/key-manager.js";
import {
  TransformersEmbeddingProvider,
  cosineSimilarity,
  type EmbeddingProvider,
} from "../../../src/memory/embeddings.js";
import type { PluginModule, PluginAPI } from "../../../src/plugin/types.js";

// ─── PMBOK Ontology ───────────────────────────────────────────────────────────

const __dirname = dirname(fileURLToPath(import.meta.url));

function loadOntology(): Record<string, unknown> {
  const ontologyPath = join(__dirname, "ontology", "pmbok.json");
  return JSON.parse(readFileSync(ontologyPath, "utf-8")) as Record<string, unknown>;
}

// ─── KnowledgeDatabase ────────────────────────────────────────────────────────

const SCHEMA_DDL = `
  CREATE TABLE IF NOT EXISTS knowledge_chunks (
    id          TEXT PRIMARY KEY,
    source_path TEXT NOT NULL,
    chunk_index INTEGER NOT NULL,
    chunk_text  TEXT NOT NULL,
    embedding   BLOB,
    mtime       INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_kc_source ON knowledge_chunks(source_path);
`;

class KnowledgeDatabase {
  private db: SqlJsDatabase | null = null;
  private dbPath: string;
  private dirty = false;

  constructor(dbPath: string) {
    this.dbPath = dbPath;
  }

  async open(): Promise<void> {
    const SQL = await initSqlJs();

    if (existsSync(this.dbPath)) {
      const rawBuffer = readFileSync(this.dbPath);
      let sqliteBuffer: Buffer;

      if (keyManager.isReady() && keyManager.isEncrypted(rawBuffer)) {
        sqliteBuffer = keyManager.decrypt(rawBuffer);
      } else {
        sqliteBuffer = rawBuffer;
      }

      this.db = new SQL.Database(sqliteBuffer);
    } else {
      mkdirSync(dirname(this.dbPath), { recursive: true });
      this.db = new SQL.Database();
    }

    this.db.run("PRAGMA journal_mode=WAL");
    this.db.run(SCHEMA_DDL);
    this.dirty = true;
    this.save();
  }

  save(): void {
    if (!this.db || !this.dirty) return;

    const data = this.db.export();
    const sqliteBuffer = Buffer.from(data);
    const dataToWrite = keyManager.isReady() ? keyManager.encrypt(sqliteBuffer) : sqliteBuffer;

    const tmpPath = this.dbPath + ".tmp";
    mkdirSync(dirname(this.dbPath), { recursive: true });
    writeFileSync(tmpPath, dataToWrite, { mode: 0o600 });
    renameSync(tmpPath, this.dbPath);
    this.dirty = false;
  }

  close(): void {
    if (this.db) {
      this.save();
      this.db.close();
      this.db = null;
    }
  }

  private requireDb(): SqlJsDatabase {
    if (!this.db) throw new Error("KnowledgeDatabase not opened. Call open() first.");
    return this.db;
  }

  /** Run a SELECT and return all rows as objects via prepare/step (avoids exec) */
  private query(sql: string, params: SqlValue[] = []): Record<string, SqlValue>[] {
    const db = this.requireDb();
    const stmt = db.prepare(sql);
    try {
      if (params.length > 0) stmt.bind(params);
      const rows: Record<string, SqlValue>[] = [];
      while (stmt.step()) {
        rows.push(stmt.getAsObject());
      }
      return rows;
    } finally {
      stmt.free();
    }
  }

  /** Return stored mtime for a source path, or null if not indexed */
  getStoredMtime(sourcePath: string): number | null {
    const rows = this.query(
      "SELECT mtime FROM knowledge_chunks WHERE source_path = ? LIMIT 1",
      [sourcePath]
    );
    if (rows.length === 0) return null;
    return rows[0]["mtime"] as number;
  }

  /** Delete all chunks for a source path */
  deleteChunks(sourcePath: string): void {
    const db = this.requireDb();
    db.run("DELETE FROM knowledge_chunks WHERE source_path = ?", [sourcePath]);
    this.dirty = true;
  }

  /** Insert a single chunk */
  insertChunk(
    sourcePath: string,
    chunkIndex: number,
    chunkText: string,
    embedding: Float32Array,
    mtime: number
  ): void {
    const db = this.requireDb();
    const id = randomUUID();
    const embBlob = Buffer.from(embedding.buffer);

    db.run(
      `INSERT INTO knowledge_chunks (id, source_path, chunk_index, chunk_text, embedding, mtime)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [id, sourcePath, chunkIndex, chunkText, embBlob as unknown as SqlValue, mtime]
    );
    this.dirty = true;
  }

  /** Get all chunk embeddings for in-process vector search */
  getAllEmbeddings(): Array<{
    id: string;
    source_path: string;
    chunk_text: string;
    embedding: Float32Array;
  }> {
    const rows = this.query(
      "SELECT id, source_path, chunk_text, embedding FROM knowledge_chunks WHERE embedding IS NOT NULL"
    );

    return rows
      .filter((r) => r["embedding"] !== null)
      .map((r) => ({
        id: r["id"] as string,
        source_path: r["source_path"] as string,
        chunk_text: r["chunk_text"] as string,
        embedding: new Float32Array((r["embedding"] as Uint8Array).buffer),
      }));
  }

  /** List unique sources with aggregate stats */
  listSources(): Array<{ source_path: string; chunk_count: number; last_indexed: number }> {
    const rows = this.query(
      "SELECT source_path, COUNT(*) as chunk_count, MAX(mtime) as last_indexed FROM knowledge_chunks GROUP BY source_path ORDER BY source_path"
    );
    return rows.map((r) => ({
      source_path: r["source_path"] as string,
      chunk_count: r["chunk_count"] as number,
      last_indexed: r["last_indexed"] as number,
    }));
  }

  isOpen(): boolean {
    return this.db !== null;
  }
}

// ─── KnowledgeManager ────────────────────────────────────────────────────────

class KnowledgeManager {
  private db: KnowledgeDatabase;
  private embedder: EmbeddingProvider;
  private knowledgeBasePath: string | null;
  private chunkSize: number;
  private chunkOverlap: number;
  private reindexOnStart: boolean;
  private ontology: Record<string, unknown>;
  private logger: PluginAPI["logger"];

  constructor(opts: {
    dbPath: string;
    knowledgeBasePath: string | null;
    chunkSize: number;
    chunkOverlap: number;
    reindexOnStart: boolean;
    logger: PluginAPI["logger"];
  }) {
    this.db = new KnowledgeDatabase(opts.dbPath);
    this.embedder = new TransformersEmbeddingProvider();
    this.knowledgeBasePath = opts.knowledgeBasePath;
    this.chunkSize = opts.chunkSize;
    this.chunkOverlap = opts.chunkOverlap;
    this.reindexOnStart = opts.reindexOnStart;
    this.logger = opts.logger;
    this.ontology = loadOntology();
  }

  async start(): Promise<void> {
    await this.db.open();

    if (this.knowledgeBasePath) {
      try {
        await this.embedder.initialize();
        this.logger.info(`PM Knowledge: embedding model ready (${this.embedder.modelName})`);
      } catch (err) {
        this.logger.warn(
          `PM Knowledge: Transformers.js not available — semantic search disabled. ` +
          `Install @xenova/transformers to enable. Error: ${err instanceof Error ? err.message : String(err)}`
        );
      }

      await this.indexDocuments(this.reindexOnStart);
    } else {
      this.logger.info("PM Knowledge: no knowledgeBasePath configured — ontology-only mode.");
    }
  }

  async stop(): Promise<void> {
    this.db.save();
    this.db.close();
    await this.embedder.dispose();
  }

  // ─── Document Indexing ──────────────────────────────────────────

  private async indexDocuments(forceReindex: boolean): Promise<void> {
    if (!this.knowledgeBasePath) return;

    let dirStat: ReturnType<typeof statSync>;
    try {
      dirStat = statSync(this.knowledgeBasePath);
    } catch {
      this.logger.warn(`PM Knowledge: knowledgeBasePath not found: ${this.knowledgeBasePath}`);
      return;
    }

    if (!dirStat.isDirectory()) {
      this.logger.warn(`PM Knowledge: knowledgeBasePath is not a directory: ${this.knowledgeBasePath}`);
      return;
    }

    const files = this.discoverFiles(this.knowledgeBasePath);
    this.logger.info(`PM Knowledge: discovered ${files.length} indexable files.`);

    let indexed = 0;
    let skipped = 0;

    for (const filePath of files) {
      try {
        const fileStat = statSync(filePath);
        const mtime = fileStat.mtimeMs;

        if (!forceReindex) {
          const storedMtime = this.db.getStoredMtime(filePath);
          if (storedMtime !== null && storedMtime >= mtime) {
            skipped++;
            continue;
          }
        }

        const text = await this.extractText(filePath);
        if (!text || text.trim().length === 0) continue;

        const chunks = this.chunkText(text, this.chunkSize, this.chunkOverlap);
        this.db.deleteChunks(filePath);

        for (let i = 0; i < chunks.length; i++) {
          let embedding: Float32Array;
          try {
            embedding = await this.embedder.embed(chunks[i]);
          } catch {
            embedding = new Float32Array(this.embedder.dimensions);
          }
          this.db.insertChunk(filePath, i, chunks[i], embedding, mtime);
        }

        indexed++;
        this.logger.info(`PM Knowledge: indexed "${filePath}" (${chunks.length} chunks)`);
      } catch (err) {
        this.logger.warn(
          `PM Knowledge: failed to index "${filePath}": ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }

    this.db.save();
    this.logger.info(`PM Knowledge: complete — ${indexed} indexed, ${skipped} unchanged.`);
  }

  /** Recursively discover .pdf, .txt, .md files */
  private discoverFiles(dir: string): string[] {
    const supported = new Set([".pdf", ".txt", ".md", ".markdown"]);
    const results: string[] = [];

    const walk = (current: string): void => {
      let entries: ReturnType<typeof readdirSync>;
      try {
        entries = readdirSync(current, { withFileTypes: true });
      } catch {
        return;
      }

      for (const entry of entries) {
        if (entry.name.startsWith(".")) continue;
        const fullPath = join(current, entry.name);
        if (entry.isDirectory()) {
          walk(fullPath);
        } else if (entry.isFile() && supported.has(extname(entry.name).toLowerCase())) {
          results.push(fullPath);
        }
      }
    };

    walk(dir);
    return results;
  }

  /** Extract plain text from a file. PDF parsing requires `npm install pdf-parse`. */
  private async extractText(filePath: string): Promise<string> {
    const ext = extname(filePath).toLowerCase();

    if (ext === ".txt" || ext === ".md" || ext === ".markdown") {
      return readFileSync(filePath, "utf-8");
    }

    if (ext === ".pdf") {
      try {
        const pdfParse = await import("pdf-parse");
        const buffer = readFileSync(filePath);
        const result = await (pdfParse.default ?? pdfParse)(buffer);
        return result.text as string;
      } catch (err) {
        const isImportError =
          err instanceof Error && err.message.includes("Cannot find package");
        if (isImportError) {
          throw new Error(
            `PDF parsing requires 'pdf-parse': run \`npm install pdf-parse\` then re-index.`
          );
        }
        throw err;
      }
    }

    return "";
  }

  /** Split text into overlapping chunks */
  private chunkText(text: string, size: number, overlap: number): string[] {
    const chunks: string[] = [];
    let start = 0;

    while (start < text.length) {
      const end = Math.min(start + size, text.length);
      const chunk = text.slice(start, end).trim();
      if (chunk.length > 0) chunks.push(chunk);
      start += size - overlap;
    }

    return chunks;
  }

  // ─── Tool Implementations ────────────────────────────────────────

  async searchKnowledgeBase(
    query: string,
    topK: number = 5
  ): Promise<Array<{ source: string; chunk: string; score: number }>> {
    let queryVec: Float32Array;
    try {
      queryVec = await this.embedder.embed(query);
    } catch {
      return [{
        source: "error",
        chunk: "Embedding model not available. Install @xenova/transformers.",
        score: 0,
      }];
    }

    const allChunks = this.db.getAllEmbeddings();
    if (allChunks.length === 0) {
      return [{
        source: "info",
        chunk: "No documents indexed. Configure knowledgeBasePath and restart.",
        score: 0,
      }];
    }

    const scored = allChunks.map((c) => ({
      source: c.source_path,
      chunk: c.chunk_text,
      score: (cosineSimilarity(queryVec, c.embedding) + 1) / 2,
    }));

    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, topK);
  }

  lookupPmConcept(
    concept: string,
    category?: string
  ): Record<string, unknown> | string {
    const needle = concept.toLowerCase();
    const ontology = this.ontology as Record<string, Record<string, unknown>>;

    const categories: string[] = category
      ? [category]
      : ["processGroups", "knowledgeAreas", "riskCategories", "evm", "stakeholderEngagement"];

    for (const cat of categories) {
      const section = ontology[cat];
      if (!section || typeof section !== "object") continue;

      const exactKey = Object.keys(section).find((k) => k.toLowerCase() === needle);
      if (exactKey) {
        return { category: cat, key: exactKey, data: section[exactKey] };
      }

      for (const [key, value] of Object.entries(section)) {
        const valStr = JSON.stringify(value).toLowerCase();
        if (key.toLowerCase().includes(needle) || valStr.includes(needle)) {
          return { category: cat, key, data: value };
        }
      }
    }

    const allText = JSON.stringify(ontology).toLowerCase();
    if (allText.includes(needle)) {
      return {
        message: `"${concept}" found in ontology but not in a top-level entry. Try a more specific term.`,
        hint: `Available categories: ${Object.keys(ontology).filter((k) => k !== "_meta").join(", ")}`,
      };
    }

    return (
      `No PMI ontology entry found for "${concept}". ` +
      `Available categories: ${Object.keys(ontology).filter((k) => k !== "_meta").join(", ")}`
    );
  }

  listIndexedSources(): Array<{ source_path: string; chunk_count: number; last_indexed: string }> {
    return this.db.listSources().map((row) => ({
      source_path: row.source_path,
      chunk_count: row.chunk_count,
      last_indexed: new Date(row.last_indexed).toISOString(),
    }));
  }
}

// ─── Plugin Definition ────────────────────────────────────────────────────────

let knowledgeManagerInstance: KnowledgeManager | null = null;

const pmKnowledgePlugin: PluginModule = {
  id: "executive.pm-knowledge",
  name: "PM Knowledge Base",
  version: "1.0.0",
  description: "Enterprise PM knowledge foundation with semantic search and PMI ontology",

  async register(api: PluginAPI): Promise<void> {
    const config = api.pluginConfig as {
      knowledgeBasePath?: string;
      chunkSize?: number;
      chunkOverlap?: number;
      reindexOnStart?: boolean;
    };

    const knowledgeBasePath = config.knowledgeBasePath
      ? api.resolvePath(config.knowledgeBasePath)
      : null;

    const manager = new KnowledgeManager({
      dbPath: api.resolvePath("~/.lliam/pm-knowledge.db"),
      knowledgeBasePath,
      chunkSize: config.chunkSize ?? 800,
      chunkOverlap: config.chunkOverlap ?? 150,
      reindexOnStart: config.reindexOnStart ?? false,
      logger: api.logger,
    });

    knowledgeManagerInstance = manager;

    // ─── Service registration ──────────────────────────────────────

    api.registerService({
      id: "pm-knowledge",
      async start() {
        await manager.start();
      },
      async stop() {
        await manager.stop();
      },
    });

    // ─── search_knowledge_base ─────────────────────────────────────

    api.registerTool({
      name: "search_knowledge_base",
      description:
        "Semantic search over the organization's indexed PM standards library. " +
        "Returns the most relevant document chunks with source attribution. " +
        "Use this when answering questions covered by the org's licensed standards, " +
        "internal policies, or methodology documentation.",
      parameters: {
        type: "object" as const,
        properties: {
          query: {
            type: "string",
            description: "Natural language search query (e.g. 'change control process', 'EVM thresholds')",
          },
          top_k: {
            type: "number",
            description: "Number of results to return (default: 5, max: 20)",
          },
        },
        required: ["query"],
      },
      async execute(_toolCallId: string, params: Record<string, unknown>) {
        const query = String(params["query"]);
        const topK = Math.min(Number(params["top_k"] ?? 5), 20);

        const results = await manager.searchKnowledgeBase(query, topK);

        return {
          content: JSON.stringify({
            query,
            results: results.map((r, i) => ({
              rank: i + 1,
              score: Math.round(r.score * 1000) / 1000,
              source: r.source,
              excerpt: r.chunk.slice(0, 400) + (r.chunk.length > 400 ? "…" : ""),
            })),
          }, null, 2),
        };
      },
    });

    // ─── lookup_pm_concept ─────────────────────────────────────────

    api.registerTool({
      name: "lookup_pm_concept",
      description:
        "Structured lookup of PM concepts, processes, and definitions from the built-in PMI ontology. " +
        "Covers PMBOK process groups, knowledge areas, risk categories, EVM formulas, and " +
        "stakeholder engagement levels. Use this before generating any PM artifact to ground " +
        "the output in PMI-standard terminology.",
      parameters: {
        type: "object" as const,
        properties: {
          concept: {
            type: "string",
            description: "PM concept to look up (e.g. 'Initiating', 'Schedule Management', 'CPI', 'Engage')",
          },
          category: {
            type: "string",
            enum: ["processGroups", "knowledgeAreas", "riskCategories", "evm", "stakeholderEngagement"],
            description: "Ontology category to search within (optional — searches all if omitted)",
          },
        },
        required: ["concept"],
      },
      async execute(_toolCallId: string, params: Record<string, unknown>) {
        const concept = String(params["concept"]);
        const category = params["category"] ? String(params["category"]) : undefined;
        const result = manager.lookupPmConcept(concept, category);

        return {
          content: typeof result === "string"
            ? result
            : JSON.stringify(result, null, 2),
        };
      },
    });

    // ─── list_indexed_sources ──────────────────────────────────────

    api.registerTool({
      name: "list_indexed_sources",
      description:
        "List all documents currently indexed in the PM knowledge base. " +
        "Returns source file paths, chunk counts, and last indexed timestamps. " +
        "Use this to verify what standards and documentation are available for retrieval.",
      parameters: {
        type: "object" as const,
        properties: {},
        required: [],
      },
      async execute(_toolCallId: string, _params: Record<string, unknown>) {
        const sources = manager.listIndexedSources();

        if (sources.length === 0) {
          return {
            content: knowledgeBasePath
              ? `No documents indexed yet. knowledgeBasePath is "${knowledgeBasePath}". Restart to trigger indexing.`
              : "No knowledgeBasePath configured. Set this in your Lliam plugin config to enable document indexing.",
          };
        }

        return {
          content: JSON.stringify({
            indexed_document_count: sources.length,
            total_chunks: sources.reduce((sum, s) => sum + s.chunk_count, 0),
            sources,
          }, null, 2),
        };
      },
    });

    api.logger.info("PM Knowledge Base plugin registered.");
  },
};

export default pmKnowledgePlugin;
export { knowledgeManagerInstance as knowledgeManager };
