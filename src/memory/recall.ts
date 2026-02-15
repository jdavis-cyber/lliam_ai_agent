/**
 * MemoryRecaller — Inject relevant memories into agent context.
 *
 * Triggered via the `before_agent_start` hook before each conversation turn.
 * Embeds the user's message, performs hybrid search, and formats top memories
 * as a <relevant-memories> block injected into the system prompt.
 */

import { HybridSearcher, type SearchOptions } from "./search.js";
import type { MemorySearchResult } from "./schema.js";

/**
 * Configuration for memory recall.
 */
export interface RecallConfig {
  /** Enable/disable auto-recall */
  enabled: boolean;
  /** Maximum memories to inject into context. Default: 5 */
  maxRecall: number;
  /** Minimum relevance score (0-1). Default: 0.3 */
  minScore: number;
  /** Vector weight in hybrid search. Default: 0.7 */
  vectorWeight: number;
  /** Keyword weight in hybrid search. Default: 0.3 */
  keywordWeight: number;
}

export const DEFAULT_RECALL_CONFIG: RecallConfig = {
  enabled: true,
  maxRecall: 5,
  minScore: 0.3,
  vectorWeight: 0.7,
  keywordWeight: 0.3,
};

export class MemoryRecaller {
  private searcher: HybridSearcher;
  private config: RecallConfig;

  constructor(searcher: HybridSearcher, config?: Partial<RecallConfig>) {
    this.searcher = searcher;
    this.config = { ...DEFAULT_RECALL_CONFIG, ...config };
  }

  /**
   * Find relevant memories for a user message and format them for injection.
   *
   * @param userMessage The user's current message
   * @returns Object with memories found and the formatted context block
   */
  async recall(userMessage: string): Promise<{
    memories: MemorySearchResult[];
    contextBlock: string;
  }> {
    if (!this.config.enabled) {
      return { memories: [], contextBlock: "" };
    }

    const searchOptions: SearchOptions = {
      maxResults: this.config.maxRecall,
      minScore: this.config.minScore,
      vectorWeight: this.config.vectorWeight,
      keywordWeight: this.config.keywordWeight,
      vectorSearch: true,
      keywordSearch: true,
    };

    let memories: MemorySearchResult[];
    try {
      memories = await this.searcher.search(userMessage, searchOptions);
    } catch (err) {
      console.error("[memory:recall] Search failed:", err);
      return { memories: [], contextBlock: "" };
    }

    if (memories.length === 0) {
      return { memories: [], contextBlock: "" };
    }

    const contextBlock = this.formatContextBlock(memories);
    return { memories, contextBlock };
  }

  /**
   * Format memories into a structured XML block for system prompt injection.
   *
   * Format chosen for Claude:
   * - XML tags for clear structure
   * - Category and confidence metadata
   * - Score for transparency
   */
  formatContextBlock(memories: MemorySearchResult[]): string {
    if (memories.length === 0) return "";

    const memoryLines = memories.map((result, i) => {
      const { memory, score, matchType } = result;
      const tags = memory.tags.length > 0 ? ` tags="${memory.tags.join(", ")}"` : "";
      return (
        `  <memory index="${i + 1}" category="${memory.category}" ` +
        `confidence="${memory.confidence.toFixed(2)}" ` +
        `relevance="${score.toFixed(3)}" match="${matchType}"${tags}>\n` +
        `    ${memory.content}\n` +
        `  </memory>`
      );
    });

    return (
      `<relevant-memories count="${memories.length}">\n` +
      `${memoryLines.join("\n")}\n` +
      `</relevant-memories>`
    );
  }
}
