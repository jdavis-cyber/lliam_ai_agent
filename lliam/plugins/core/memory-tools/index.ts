/**
 * Memory Tools Plugin — Provides tools and hooks for persistent memory.
 *
 * Tools:
 * - memory_store: Manually store a memory
 * - memory_search: Search memories by query
 * - memory_forget: Delete a memory by ID
 * - memory_list: List recent memories
 * - memory_stats: Get memory system statistics
 *
 * Hooks:
 * - before_agent_start: Auto-recall relevant memories into system prompt
 * - agent_end: Auto-capture memories from conversation
 */

import type { PluginModule, PluginAPI } from "../../../src/plugin/types.js";

const memoryToolsPlugin: PluginModule = {
  id: "core.memory",
  name: "Memory Tools",
  version: "1.0.0",
  description: "Persistent memory with hybrid search, auto-capture, and auto-recall",

  register(api: PluginAPI): void {
    const config = api.pluginConfig ?? {};
    const autoCapture = config.autoCapture !== false;
    const autoRecall = config.autoRecall !== false;
    const maxRecall = (config.maxRecall as number) ?? 5;
    const minScore = (config.minScore as number) ?? 0.3;

    // ─── Tools ───────────────────────────────────────────────────

    api.registerTool({
      name: "memory_store",
      description:
        "Store a new memory. Use this when the user explicitly asks you to remember something, " +
        "or when you identify important information worth preserving across conversations.",
      parameters: {
        type: "object",
        properties: {
          content: {
            type: "string",
            description: "The memory content to store (a single, concise fact)",
          },
          category: {
            type: "string",
            description:
              "Category: preference, fact, decision, entity, procedure, or other",
          },
          tags: {
            type: "string",
            description: "Comma-separated tags for organization",
          },
        },
        required: ["content"],
      },
      execute: async (_toolCallId: string, params: Record<string, unknown>) => {
        const content = String(params.content);
        const category = String(params.category || "other");
        const tags = params.tags
          ? String(params.tags)
              .split(",")
              .map((t: string) => t.trim())
              .filter(Boolean)
          : [];

        // MemoryManager is injected via service registry at runtime
        const manager = api.getService?.("memory-manager");
        if (!manager) {
          return {
            content: "Memory system not available. The memory manager service is not registered.",
            isError: true,
          };
        }

        try {
          const id = await (manager as { store: Function }).store({
            content,
            category,
            tags,
            sourceType: "manual",
          });
          return {
            content: `Memory stored successfully (ID: ${id}). Category: ${category}. Tags: ${tags.join(", ") || "none"}.`,
          };
        } catch (err) {
          return {
            content: `Failed to store memory: ${err instanceof Error ? err.message : String(err)}`,
            isError: true,
          };
        }
      },
    });

    api.registerTool({
      name: "memory_search",
      description:
        "Search stored memories using natural language. Uses hybrid vector + keyword search " +
        "for best results. Use this when the user asks 'do you remember...', 'what do you know about...', etc.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "Natural language search query",
          },
          max_results: {
            type: "number",
            description: "Maximum number of results (default: 5)",
          },
          category: {
            type: "string",
            description: "Filter by category (optional)",
          },
        },
        required: ["query"],
      },
      execute: async (_toolCallId: string, params: Record<string, unknown>) => {
        const query = String(params.query);
        const maxResults = Number(params.max_results) || 5;

        const manager = api.getService?.("memory-manager");
        if (!manager) {
          return {
            content: "Memory system not available.",
            isError: true,
          };
        }

        try {
          const results = await (manager as { search: Function }).search(query, {
            maxResults,
          });

          if (results.length === 0) {
            return { content: "No memories found matching your query." };
          }

          const formatted = results
            .map(
              (r: { memory: { content: string; category: string; tags: string[] }; score: number; matchType: string }, i: number) =>
                `${i + 1}. [${r.memory.category}] ${r.memory.content} (relevance: ${r.score.toFixed(2)}, match: ${r.matchType})`
            )
            .join("\n");

          return {
            content: `Found ${results.length} memor${results.length === 1 ? "y" : "ies"}:\n${formatted}`,
          };
        } catch (err) {
          return {
            content: `Search failed: ${err instanceof Error ? err.message : String(err)}`,
            isError: true,
          };
        }
      },
    });

    api.registerTool({
      name: "memory_forget",
      description:
        "Delete a specific memory by its ID. Use when the user asks to forget something " +
        "or when information is no longer accurate.",
      parameters: {
        type: "object",
        properties: {
          memory_id: {
            type: "string",
            description: "The UUID of the memory to delete",
          },
        },
        required: ["memory_id"],
      },
      execute: async (_toolCallId: string, params: Record<string, unknown>) => {
        const memoryId = String(params.memory_id);

        const manager = api.getService?.("memory-manager");
        if (!manager) {
          return { content: "Memory system not available.", isError: true };
        }

        try {
          const deleted = (manager as { delete: Function }).delete(memoryId);
          return {
            content: deleted
              ? `Memory ${memoryId} deleted successfully.`
              : `Memory ${memoryId} not found.`,
          };
        } catch (err) {
          return {
            content: `Delete failed: ${err instanceof Error ? err.message : String(err)}`,
            isError: true,
          };
        }
      },
    });

    api.registerTool({
      name: "memory_list",
      description: "List recent memories, optionally filtered by category.",
      parameters: {
        type: "object",
        properties: {
          category: {
            type: "string",
            description: "Filter by category (optional)",
          },
          limit: {
            type: "number",
            description: "Max memories to return (default: 10)",
          },
        },
      },
      execute: async (_toolCallId: string, params: Record<string, unknown>) => {
        const category = params.category ? String(params.category) : undefined;
        const limit = Number(params.limit) || 10;

        const manager = api.getService?.("memory-manager");
        if (!manager) {
          return { content: "Memory system not available.", isError: true };
        }

        try {
          const memories = (manager as { list: Function }).list({ category, limit });

          if (memories.length === 0) {
            return { content: "No memories stored yet." };
          }

          const formatted = memories
            .map(
              (m: { id: string; category: string; content: string; tags: string[] }, i: number) =>
                `${i + 1}. [${m.category}] ${m.content} (ID: ${m.id.substring(0, 8)}...)`
            )
            .join("\n");

          return {
            content: `${memories.length} memor${memories.length === 1 ? "y" : "ies"}:\n${formatted}`,
          };
        } catch (err) {
          return {
            content: `List failed: ${err instanceof Error ? err.message : String(err)}`,
            isError: true,
          };
        }
      },
    });

    api.registerTool({
      name: "memory_stats",
      description: "Get statistics about the memory system.",
      parameters: {
        type: "object",
        properties: {},
      },
      execute: async (_toolCallId: string, _params: Record<string, unknown>) => {
        const manager = api.getService?.("memory-manager");
        if (!manager) {
          return { content: "Memory system not available.", isError: true };
        }

        try {
          const stats = (manager as { getStats: Function }).getStats();
          return {
            content:
              `Memory Statistics:\n` +
              `- Total memories: ${stats.totalMemories}\n` +
              `- With embeddings: ${stats.withEmbeddings}\n` +
              `- By category: ${JSON.stringify(stats.byCategory)}\n` +
              `- Database size: ${(stats.dbSizeBytes / 1024).toFixed(1)} KB`,
          };
        } catch (err) {
          return {
            content: `Stats failed: ${err instanceof Error ? err.message : String(err)}`,
            isError: true,
          };
        }
      },
    });

    // ─── Hooks ───────────────────────────────────────────────────

    if (autoRecall) {
      api.registerHook("before_agent_start", async (event) => {
        const manager = api.getService?.("memory-manager");
        if (!manager) return {};

        try {
          const { contextBlock } = await (manager as { recall: Function }).recall(
            event.userMessage
          );

          if (contextBlock) {
            api.logger.info(
              `Recalled memories for context injection`
            );
            return {
              systemPromptAdditions: [contextBlock],
            };
          }
        } catch (err) {
          api.logger.error(`Memory recall failed: ${err}`);
        }

        return {};
      }, { priority: 100 }); // High priority — memories should be injected early
    }

    if (autoCapture) {
      api.registerHook("agent_end", async (event) => {
        const manager = api.getService?.("memory-manager");
        if (!manager) return;

        // Only capture if there's a meaningful exchange
        if (!event.userMessage || !event.finalResponse) return;
        if (event.finalResponse.length < 50) return; // Skip trivial responses

        try {
          // extractFn would be wired to call Claude for memory classification
          // For now this is a placeholder — the agent-runner provides the actual extractFn
          if (event.extractFn) {
            const ids = await (manager as { captureFromConversation: Function }).captureFromConversation(
              event.userMessage,
              event.finalResponse,
              event.sessionId || "unknown",
              event.extractFn
            );

            if (ids.length > 0) {
              api.logger.info(`Auto-captured ${ids.length} memories`);
            }
          }
        } catch (err) {
          api.logger.error(`Memory capture failed: ${err}`);
        }
      }, { priority: 0 }); // Low priority — run after other hooks
    }

    api.logger.info("Memory Tools plugin registered successfully");
  },
};

export default memoryToolsPlugin;
