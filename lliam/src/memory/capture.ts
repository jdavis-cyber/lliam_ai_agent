/**
 * MemoryCapture — Extract structured memories from conversations.
 *
 * Triggered via the `agent_end` hook after each conversation turn.
 * Sends the conversation to Claude with a classifier prompt to extract
 * structured facts, preferences, and decisions.
 *
 * Deduplication: checks similarity against existing memories (0.90+ threshold)
 * to avoid storing redundant information.
 */

import type { EmbeddingProvider } from "./embeddings.js";
import { cosineSimilarity } from "./embeddings.js";
import { MemoryDatabase } from "./db.js";
import type { CreateMemoryInput, MemoryCategory } from "./schema.js";

/**
 * Extracted memory from a conversation.
 */
export interface ExtractedMemory {
  content: string;
  category: MemoryCategory;
  confidence: number;
  tags: string[];
}

/**
 * Configuration for memory capture.
 */
export interface CaptureConfig {
  /** Enable/disable auto-capture */
  enabled: boolean;
  /** Similarity threshold for deduplication (0-1). Default: 0.90 */
  deduplicationThreshold: number;
  /** Minimum confidence to store a memory (0-1). Default: 0.6 */
  minConfidence: number;
  /** Max memories to extract per conversation turn. Default: 5 */
  maxPerTurn: number;
  /** Categories to auto-capture. Default: all */
  categories: MemoryCategory[];
}

export const DEFAULT_CAPTURE_CONFIG: CaptureConfig = {
  enabled: true,
  deduplicationThreshold: 0.90,
  minConfidence: 0.6,
  maxPerTurn: 5,
  categories: ["preference", "fact", "decision", "entity", "procedure", "other"],
};

/**
 * The classifier prompt sent to Claude to extract memories.
 * Returns JSON array of structured memory objects.
 */
export const MEMORY_EXTRACTION_PROMPT = `You are a memory extraction system. Analyze the conversation and extract key facts, preferences, decisions, and entities that should be remembered for future conversations.

Rules:
1. Only extract information that is EXPLICITLY stated or clearly implied
2. Do NOT infer or assume beyond what is directly communicated
3. Focus on information the user would want remembered across conversations
4. Skip small talk, greetings, and transient information
5. Each memory should be a single, self-contained fact
6. NEVER extract sensitive information (passwords, SSN, financial details)
7. Rate your confidence: 1.0 = explicitly stated, 0.8 = clearly implied, 0.6 = somewhat implied

Respond with a JSON array. Each element:
{
  "content": "concise fact in third person (e.g., 'User prefers dark mode')",
  "category": "preference" | "fact" | "decision" | "entity" | "procedure" | "other",
  "confidence": 0.6-1.0,
  "tags": ["relevant", "tags"]
}

If nothing worth remembering, respond with: []`;

export class MemoryCapture {
  private db: MemoryDatabase;
  private embedder: EmbeddingProvider;
  private config: CaptureConfig;

  constructor(
    db: MemoryDatabase,
    embedder: EmbeddingProvider,
    config?: Partial<CaptureConfig>
  ) {
    this.db = db;
    this.embedder = embedder;
    this.config = { ...DEFAULT_CAPTURE_CONFIG, ...config };
  }

  /**
   * Extract memories from a conversation exchange.
   * @param userMessage The user's message
   * @param assistantMessage The assistant's response
   * @param sessionId Source session for provenance
   * @returns Array of stored memory IDs
   */
  async captureFromConversation(
    userMessage: string,
    assistantMessage: string,
    sessionId: string,
    extractFn: (prompt: string) => Promise<string>
  ): Promise<string[]> {
    if (!this.config.enabled) return [];

    // Build extraction prompt
    const conversationText = `USER: ${userMessage}\n\nASSISTANT: ${assistantMessage}`;
    const fullPrompt = `${MEMORY_EXTRACTION_PROMPT}\n\n---\n\nConversation:\n${conversationText}`;

    // Call Claude (via provided extractFn) to classify memories
    let rawResponse: string;
    try {
      rawResponse = await extractFn(fullPrompt);
    } catch (err) {
      console.error("[memory:capture] Extraction call failed:", err);
      return [];
    }

    // Parse extracted memories
    const extracted = this.parseExtractionResponse(rawResponse);
    if (extracted.length === 0) return [];

    // Filter by confidence and category
    const filtered = extracted
      .filter((m) => m.confidence >= this.config.minConfidence)
      .filter((m) => this.config.categories.includes(m.category))
      .slice(0, this.config.maxPerTurn);

    // Store with deduplication
    const storedIds: string[] = [];
    for (const memory of filtered) {
      const id = await this.storeWithDeduplication(memory, sessionId);
      if (id) storedIds.push(id);
    }

    return storedIds;
  }

  /**
   * Parse Claude's extraction response into structured memories.
   */
  parseExtractionResponse(response: string): ExtractedMemory[] {
    try {
      // Find JSON array in the response (Claude may wrap it in markdown)
      const jsonMatch = response.match(/\[[\s\S]*\]/);
      if (!jsonMatch) return [];

      const parsed = JSON.parse(jsonMatch[0]);
      if (!Array.isArray(parsed)) return [];

      return parsed
        .filter(
          (item: unknown) =>
            item &&
            typeof item === "object" &&
            "content" in (item as Record<string, unknown>) &&
            typeof (item as Record<string, unknown>).content === "string"
        )
        .map((item: Record<string, unknown>) => ({
          content: String(item.content),
          category: this.validateCategory(String(item.category || "other")),
          confidence: Number(item.confidence) || 0.6,
          tags: Array.isArray(item.tags)
            ? item.tags.filter((t: unknown) => typeof t === "string")
            : [],
        }));
    } catch {
      console.error("[memory:capture] Failed to parse extraction response");
      return [];
    }
  }

  /**
   * Store a memory, checking for duplicates via embedding similarity.
   * Returns the new memory ID, or null if a duplicate was found.
   */
  private async storeWithDeduplication(
    memory: ExtractedMemory,
    sessionId: string
  ): Promise<string | null> {
    // Generate embedding for the new memory
    let embedding: Float32Array;
    try {
      embedding = await this.embedder.embed(memory.content);
    } catch {
      // Store without embedding if embedding fails
      return this.db.createMemory({
        content: memory.content,
        category: memory.category,
        confidence: memory.confidence,
        tags: memory.tags,
        sourceType: "auto_capture",
        sourceSession: sessionId,
      });
    }

    // Check for duplicates
    const allEmbeddings = this.db.getAllEmbeddings();
    for (const existing of allEmbeddings) {
      try {
        const similarity = cosineSimilarity(embedding, existing.embedding);
        const normalizedSim = (similarity + 1) / 2; // Convert [-1,1] to [0,1]

        if (normalizedSim >= this.config.deduplicationThreshold) {
          // Duplicate found — skip
          console.log(
            `[memory:capture] Duplicate detected (${normalizedSim.toFixed(3)} similarity), skipping: "${memory.content.substring(0, 50)}..."`
          );
          return null;
        }
      } catch {
        // Dimension mismatch — skip this comparison
        continue;
      }
    }

    // No duplicate — store
    const input: CreateMemoryInput = {
      content: memory.content,
      category: memory.category,
      embedding,
      embeddingModel: this.embedder.modelName,
      confidence: memory.confidence,
      tags: memory.tags,
      sourceType: "auto_capture",
      sourceSession: sessionId,
    };

    return this.db.createMemory(input);
  }

  /**
   * Validate a category string, falling back to 'other'.
   */
  private validateCategory(cat: string): MemoryCategory {
    const valid = ["preference", "fact", "decision", "entity", "procedure", "other"];
    return valid.includes(cat) ? (cat as MemoryCategory) : "other";
  }
}
