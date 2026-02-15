/**
 * EmbeddingProvider — Interface + implementations for text embeddings.
 *
 * Design:
 * - Clean interface so the embedding source is swappable
 * - TransformersEmbeddingProvider: uses @xenova/transformers (all-MiniLM-L6-v2)
 *   → zero API cost, zero network, all text stays on-device
 *   → requires @xenova/transformers + sharp native deps (works on user's machine)
 * - SimpleHashEmbeddingProvider: deterministic hash-based pseudo-embeddings
 *   → for testing and development — no native deps needed
 *   → NOT for production search quality, but preserves similarity properties
 */

import { createHash } from "node:crypto";

/**
 * Interface for any embedding provider.
 */
export interface EmbeddingProvider {
  /** Human-readable model identifier (e.g., "all-MiniLM-L6-v2") */
  readonly modelName: string;

  /** Dimensionality of output vectors */
  readonly dimensions: number;

  /** Warm up / load the model. May be slow on first call. */
  initialize(): Promise<void>;

  /** Generate an embedding for a single text. */
  embed(text: string): Promise<Float32Array>;

  /** Generate embeddings for multiple texts. More efficient than sequential embed(). */
  embedBatch(texts: string[]): Promise<Float32Array[]>;

  /** Release model resources. */
  dispose(): Promise<void>;
}

// ─── Transformers.js Implementation ──────────────────────────────

/**
 * Local embedding provider using Transformers.js + all-MiniLM-L6-v2.
 * ~23MB model, downloaded once, cached locally.
 * ~50-200ms per embedding on CPU — fine for single-user.
 *
 * Requires: npm install @xenova/transformers (with native deps)
 */
export class TransformersEmbeddingProvider implements EmbeddingProvider {
  readonly modelName = "Xenova/all-MiniLM-L6-v2";
  readonly dimensions = 384;

  private pipeline: unknown = null;

  async initialize(): Promise<void> {
    if (this.pipeline) return;

    try {
      // Dynamic import — only fails if @xenova/transformers isn't installed
      const transformers = await import("@xenova/transformers");
      const { pipeline, env } = transformers;

      // Disable remote model download checks (use cached only after first download)
      env.allowRemoteModels = true;
      env.allowLocalModels = true;

      this.pipeline = await (pipeline as Function)(
        "feature-extraction",
        this.modelName,
        { quantized: true }
      );
    } catch (err) {
      throw new Error(
        `Failed to initialize Transformers.js embedding provider. ` +
          `Ensure @xenova/transformers is installed with native deps. ` +
          `Error: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  async embed(text: string): Promise<Float32Array> {
    if (!this.pipeline) {
      throw new Error("EmbeddingProvider not initialized. Call initialize() first.");
    }

    const output = await (this.pipeline as Function)(text, {
      pooling: "mean",
      normalize: true,
    });

    // output.data is a Float32Array of shape [1, dimensions]
    return new Float32Array(output.data);
  }

  async embedBatch(texts: string[]): Promise<Float32Array[]> {
    // Transformers.js handles batching internally
    const results: Float32Array[] = [];
    for (const text of texts) {
      results.push(await this.embed(text));
    }
    return results;
  }

  async dispose(): Promise<void> {
    this.pipeline = null;
  }
}

// ─── Hash-Based Test Implementation ──────────────────────────────

/**
 * Deterministic hash-based pseudo-embedding provider for testing.
 *
 * Properties:
 * - Same text always produces the same embedding
 * - Similar texts produce somewhat similar embeddings (via n-gram hashing)
 * - Vectors are normalized to unit length (valid for cosine similarity)
 * - Fast, no external dependencies
 *
 * NOT suitable for production semantic search — but correctly exercises
 * the full vector search pipeline.
 */
export class SimpleHashEmbeddingProvider implements EmbeddingProvider {
  readonly modelName = "simple-hash-v1";
  readonly dimensions: number;

  constructor(dimensions: number = 128) {
    this.dimensions = dimensions;
  }

  async initialize(): Promise<void> {
    // No-op — nothing to load
  }

  async embed(text: string): Promise<Float32Array> {
    return this.hashToVector(text);
  }

  async embedBatch(texts: string[]): Promise<Float32Array[]> {
    return texts.map((t) => this.hashToVector(t));
  }

  async dispose(): Promise<void> {
    // No-op
  }

  /**
   * Generate a deterministic pseudo-embedding from text using n-gram hashing.
   *
   * Approach:
   * 1. Extract character trigrams from normalized text
   * 2. Hash each trigram to a position in the vector
   * 3. Accumulate weighted values
   * 4. Normalize to unit vector
   */
  private hashToVector(text: string): Float32Array {
    const vec = new Float32Array(this.dimensions);
    const normalized = text.toLowerCase().trim();

    if (normalized.length === 0) return vec;

    // Generate character trigrams
    const trigrams: string[] = [];
    for (let i = 0; i <= normalized.length - 3; i++) {
      trigrams.push(normalized.substring(i, i + 3));
    }

    // Also add individual words for broader similarity
    const words = normalized.split(/\s+/).filter((w) => w.length > 0);
    trigrams.push(...words);

    // Hash each feature into the vector
    for (const feature of trigrams) {
      const hash = createHash("sha256").update(feature).digest();

      // Use first 4 bytes to determine position
      const pos = hash.readUInt32LE(0) % this.dimensions;
      // Use next 4 bytes to determine sign/magnitude
      const val = (hash.readInt32LE(4) / 2147483647) * 0.1; // normalized small value

      vec[pos] += val;
    }

    // Add a global hash component for uniqueness
    const globalHash = createHash("sha256").update(normalized).digest();
    for (let i = 0; i < this.dimensions; i++) {
      vec[i] += (globalHash[i % 32] - 128) / 2560; // very small contribution
    }

    // Normalize to unit vector
    let magnitude = 0;
    for (let i = 0; i < this.dimensions; i++) {
      magnitude += vec[i] * vec[i];
    }
    magnitude = Math.sqrt(magnitude);

    if (magnitude > 0) {
      for (let i = 0; i < this.dimensions; i++) {
        vec[i] /= magnitude;
      }
    }

    return vec;
  }
}

// ─── Vector Math Utilities ───────────────────────────────────────

/**
 * Compute cosine similarity between two vectors. Returns value in [-1, 1].
 * Assumes vectors are already normalized to unit length → dot product = cosine.
 */
export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) {
    throw new Error(`Vector dimension mismatch: ${a.length} vs ${b.length}`);
  }

  let dot = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
  }

  return dot;
}

/**
 * Normalize a vector to unit length in-place.
 */
export function normalizeVector(vec: Float32Array): Float32Array {
  let magnitude = 0;
  for (let i = 0; i < vec.length; i++) {
    magnitude += vec[i] * vec[i];
  }
  magnitude = Math.sqrt(magnitude);

  if (magnitude > 0) {
    for (let i = 0; i < vec.length; i++) {
      vec[i] /= magnitude;
    }
  }

  return vec;
}
