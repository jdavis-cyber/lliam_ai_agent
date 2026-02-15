/**
 * HybridSearcher — Combines vector (semantic) and keyword (lexical) search.
 *
 * Strategy:
 * 1. Vector search: embed query → cosine similarity against all stored embeddings
 * 2. Keyword search: FTS4 match on content
 * 3. Merge: weighted combination (0.7 vector + 0.3 keyword), deduplicate, rank
 *
 * In-process vector search is used (no sqlite-vec extension needed).
 * For a single-user system with <10K memories, this is ~1-5ms per search.
 */

import { MemoryDatabase } from "./db.js";
import { type EmbeddingProvider, cosineSimilarity } from "./embeddings.js";
import type { MemorySearchResult } from "./schema.js";

export interface SearchOptions {
  /** Maximum results to return */
  maxResults?: number;
  /** Minimum score threshold (0-1) */
  minScore?: number;
  /** Enable vector search (requires embeddings) */
  vectorSearch?: boolean;
  /** Enable keyword search (FTS4) */
  keywordSearch?: boolean;
  /** Weight for vector score in hybrid merge */
  vectorWeight?: number;
  /** Weight for keyword score in hybrid merge */
  keywordWeight?: number;
  /** Filter by category */
  category?: string;
  /** Multiply candidate fetch size (fetch more, re-rank, trim) */
  candidateMultiplier?: number;
}

const DEFAULT_OPTIONS: Required<SearchOptions> = {
  maxResults: 6,
  minScore: 0.3,
  vectorSearch: true,
  keywordSearch: true,
  vectorWeight: 0.7,
  keywordWeight: 0.3,
  category: "",
  candidateMultiplier: 4,
};

export class HybridSearcher {
  private db: MemoryDatabase;
  private embedder: EmbeddingProvider;

  constructor(db: MemoryDatabase, embedder: EmbeddingProvider) {
    this.db = db;
    this.embedder = embedder;
  }

  /**
   * Perform hybrid search combining vector and keyword results.
   */
  async search(query: string, opts?: SearchOptions): Promise<MemorySearchResult[]> {
    const options = { ...DEFAULT_OPTIONS, ...opts };
    const candidateLimit = options.maxResults * options.candidateMultiplier;

    // Run vector and keyword searches in parallel
    const [vectorResults, keywordResults] = await Promise.all([
      options.vectorSearch
        ? this.vectorSearch(query, candidateLimit)
        : Promise.resolve([]),
      options.keywordSearch
        ? this.keywordSearchInternal(query, candidateLimit)
        : Promise.resolve([]),
    ]);

    // Merge results
    const merged = this.mergeResults(vectorResults, keywordResults, options);

    // Fetch full memory records for top results
    const topIds = merged
      .filter((r) => r.score >= options.minScore)
      .slice(0, options.maxResults)
      .map((r) => r.id);

    if (topIds.length === 0) return [];

    const memories = this.db.getMemoriesByIds(topIds);
    const memoryMap = new Map(memories.map((m) => [m.id, m]));

    return merged
      .filter((r) => r.score >= options.minScore && memoryMap.has(r.id))
      .slice(0, options.maxResults)
      .map((r) => ({
        memory: memoryMap.get(r.id)!,
        score: r.score,
        matchType: r.matchType,
      }));
  }

  /**
   * Vector search using in-process cosine similarity.
   */
  private async vectorSearch(
    query: string,
    limit: number
  ): Promise<Array<{ id: string; score: number; matchType: "vector" }>> {
    // Embed the query
    let queryVec: Float32Array;
    try {
      queryVec = await this.embedder.embed(query);
    } catch {
      // If embedding fails, skip vector search
      return [];
    }

    // Get all stored embeddings
    const allEmbeddings = this.db.getAllEmbeddings();
    if (allEmbeddings.length === 0) return [];

    // Compute cosine similarity for each
    const scored = allEmbeddings
      .map(({ id, embedding }) => {
        try {
          const sim = cosineSimilarity(queryVec, embedding);
          // Convert from [-1, 1] to [0, 1] range
          const score = (sim + 1) / 2;
          return { id, score, matchType: "vector" as const };
        } catch {
          return { id, score: 0, matchType: "vector" as const };
        }
      })
      .filter((r) => r.score > 0);

    // Sort by score descending, take top N
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, limit);
  }

  /**
   * Keyword search using FTS4.
   */
  private keywordSearchInternal(
    query: string,
    limit: number
  ): Array<{ id: string; score: number; matchType: "keyword" }> {
    const rawResults = this.db.keywordSearch(query, limit);

    // Normalize FTS scores to 0-1 range
    if (rawResults.length === 0) return [];

    const maxScore = Math.max(...rawResults.map((r) => r.score));
    const normalizer = maxScore > 0 ? maxScore : 1;

    return rawResults.map((r) => ({
      id: r.id,
      score: r.score / normalizer,
      matchType: "keyword" as const,
    }));
  }

  /**
   * Merge vector and keyword results using weighted combination.
   */
  private mergeResults(
    vectorResults: Array<{ id: string; score: number; matchType: "vector" }>,
    keywordResults: Array<{ id: string; score: number; matchType: "keyword" }>,
    options: Required<SearchOptions>
  ): Array<{ id: string; score: number; matchType: "vector" | "keyword" | "hybrid" }> {
    const byId = new Map<
      string,
      { vectorScore: number; keywordScore: number }
    >();

    // Add vector results
    for (const r of vectorResults) {
      byId.set(r.id, { vectorScore: r.score, keywordScore: 0 });
    }

    // Merge keyword results
    for (const r of keywordResults) {
      const existing = byId.get(r.id);
      if (existing) {
        existing.keywordScore = r.score;
      } else {
        byId.set(r.id, { vectorScore: 0, keywordScore: r.score });
      }
    }

    // Compute final scores
    const results: Array<{
      id: string;
      score: number;
      matchType: "vector" | "keyword" | "hybrid";
    }> = [];

    for (const [id, scores] of byId) {
      const finalScore =
        options.vectorWeight * scores.vectorScore +
        options.keywordWeight * scores.keywordScore;

      let matchType: "vector" | "keyword" | "hybrid";
      if (scores.vectorScore > 0 && scores.keywordScore > 0) {
        matchType = "hybrid";
      } else if (scores.vectorScore > 0) {
        matchType = "vector";
      } else {
        matchType = "keyword";
      }

      results.push({ id, score: finalScore, matchType });
    }

    // Sort by final score descending
    results.sort((a, b) => b.score - a.score);
    return results;
  }
}
