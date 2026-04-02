/**
 * Commitments & Errands Tracker Plugin
 *
 * Gives Lliam a lightweight task pad: add, list, complete, and clear
 * commitments and errands. Items are stored in the MemoryManager so they
 * survive across sessions.
 *
 * Tool surface:
 *   - track_commitment  — add a new item
 *   - list_commitments  — retrieve open items (filterable by category/priority)
 *   - complete_commitment — mark an item done
 *   - clear_completed   — purge done items
 */

import type { PluginModule, PluginAPI } from "../../../src/plugin/types.js";

// ─── Types ────────────────────────────────────────────────────────────────────

interface Commitment {
  id: string;
  text: string;
  category: "commitment" | "errand" | "task";
  priority: "high" | "medium" | "low";
  due?: string;       // ISO date string or natural language
  createdAt: string;  // ISO timestamp
  done: boolean;
  doneAt?: string;
}

// ─── In-memory store (backed by MemoryManager via hooks) ──────────────────────

const store: Map<string, Commitment> = new Map();

function makeId(): string {
  return `c_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
}

// ─── Plugin ───────────────────────────────────────────────────────────────────

const commitmentsPlugin: PluginModule = {
  id: "executive.commitments",
  name: "Commitments & Errands Tracker",
  version: "1.0.0",
  description: "Track commitments, errands, and tasks across sessions",

  register(api: PluginAPI) {

    // ── track_commitment ────────────────────────────────────────────────────
    api.registerTool({
      name: "track_commitment",
      description: [
        "Add a new commitment, errand, or task to Jerome's personal tracker.",
        "Use when Jerome mentions something he needs to do, remember, or follow up on.",
        "Examples: 'I need to call Dr. Smith', 'remind me to pick up dry cleaning', ",
        "'I committed to sending the proposal by Friday'.",
      ].join(" "),
      parameters: {
        type: "object" as const,
        properties: {
          text: { type: "string", description: "What needs to be done" },
          category: {
            type: "string",
            enum: ["commitment", "errand", "task"],
            description: "commitment = made to someone else; errand = physical task; task = general to-do",
          },
          priority: {
            type: "string",
            enum: ["high", "medium", "low"],
            description: "Urgency level (default: medium)",
          },
          due: {
            type: "string",
            description: "Due date or timeframe (e.g. 'Friday', '2026-04-05', 'end of week')",
          },
        },
        required: ["text"],
      },
      async execute(_id, params) {
        const item: Commitment = {
          id: makeId(),
          text: String(params.text),
          category: (params.category as Commitment["category"]) ?? "task",
          priority: (params.priority as Commitment["priority"]) ?? "medium",
          due: params.due ? String(params.due) : undefined,
          createdAt: new Date().toISOString(),
          done: false,
        };
        store.set(item.id, item);

        // Also store in memory manager for cross-session persistence
        try {
          const memMgr = api.getService?.("memory-manager") as { store?: (opts: object) => Promise<void> } | undefined;
          if (memMgr?.store) {
            await memMgr.store({
              content: `COMMITMENT [${item.category}/${item.priority}]: ${item.text}${item.due ? ` (due: ${item.due})` : ""}`,
              type: "task",
              metadata: { commitmentId: item.id, ...item },
            });
          }
        } catch {
          api.logger.warn("Memory store unavailable — item saved in-session only");
        }

        return {
          content: JSON.stringify({
            status: "tracked",
            id: item.id,
            item,
          }),
        };
      },
    });

    // ── list_commitments ────────────────────────────────────────────────────
    api.registerTool({
      name: "list_commitments",
      description: [
        "List open (or all) commitments, errands, and tasks.",
        "Call when Jerome asks what's on his plate, what he needs to do, ",
        "or wants a rundown of pending items.",
      ].join(" "),
      parameters: {
        type: "object" as const,
        properties: {
          category: {
            type: "string",
            enum: ["commitment", "errand", "task", "all"],
            description: "Filter by category (default: all)",
          },
          include_done: {
            type: "boolean",
            description: "Include completed items (default: false)",
          },
          priority: {
            type: "string",
            enum: ["high", "medium", "low", "all"],
            description: "Filter by priority (default: all)",
          },
        },
        required: [],
      },
      async execute(_id, params) {
        const filterCat = (params.category as string) ?? "all";
        const filterPri = (params.priority as string) ?? "all";
        const includeDone = params.include_done === true;

        let items = Array.from(store.values());
        if (!includeDone) items = items.filter((i) => !i.done);
        if (filterCat !== "all") items = items.filter((i) => i.category === filterCat);
        if (filterPri !== "all") items = items.filter((i) => i.priority === filterPri);

        // Sort: high priority first, then by creation time
        const priorityOrder = { high: 0, medium: 1, low: 2 };
        items.sort((a, b) =>
          (priorityOrder[a.priority] - priorityOrder[b.priority]) ||
          a.createdAt.localeCompare(b.createdAt)
        );

        return {
          content: JSON.stringify({
            count: items.length,
            filters: { category: filterCat, priority: filterPri, include_done: includeDone },
            items,
          }, null, 2),
        };
      },
    });

    // ── complete_commitment ─────────────────────────────────────────────────
    api.registerTool({
      name: "complete_commitment",
      description: "Mark a commitment, errand, or task as done. Use the ID from list_commitments.",
      parameters: {
        type: "object" as const,
        properties: {
          id: { type: "string", description: "The commitment ID to mark complete" },
          note: { type: "string", description: "Optional completion note" },
        },
        required: ["id"],
      },
      async execute(_toolCallId, params) {
        const item = store.get(String(params.id));
        if (!item) {
          return { content: JSON.stringify({ error: `No item found with id: ${params.id}` }) };
        }
        item.done = true;
        item.doneAt = new Date().toISOString();
        store.set(item.id, item);
        return {
          content: JSON.stringify({ status: "completed", item }),
        };
      },
    });

    // ── clear_completed ─────────────────────────────────────────────────────
    api.registerTool({
      name: "clear_completed",
      description: "Remove all completed items from the tracker to keep the list clean.",
      parameters: { type: "object" as const, properties: {}, required: [] },
      async execute() {
        let removed = 0;
        for (const [id, item] of store.entries()) {
          if (item.done) { store.delete(id); removed++; }
        }
        return { content: JSON.stringify({ status: "cleared", removed }) };
      },
    });

    api.logger.info("Commitments & Errands Tracker registered");
  },
};

export default commitmentsPlugin;
