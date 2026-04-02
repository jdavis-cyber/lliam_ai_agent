/**
 * Web Search Plugin
 *
 * Provides real-time web search via Brave Search API (free tier: 2k queries/month).
 * Falls back to DuckDuckGo Instant Answer API if no Brave key is configured —
 * no API key required for DDG, but results are more limited.
 *
 * Tools:
 *   - web_search   — keyword/question search, returns ranked results
 *   - fetch_page   — fetch and extract text from a URL (for reading articles)
 *
 * Config:
 *   BRAVE_API_KEY env var     — get free key at https://api.search.brave.com/
 *   maxDailySearches          — daily cap per calendar day (default: 20)
 *   maxSessionSearches        — per-plugin-instance cap (default: 5)
 *
 * Rate limiting:
 *   - Minimum 1000ms between web_search calls
 *   - Session cap resets when the plugin instance is garbage collected (process restart)
 *   - Daily cap resets at midnight local time
 */

import { request } from "node:https";
import type { PluginModule, PluginAPI } from "../../../src/plugin/types.js";

// ─── HTTP Helpers ─────────────────────────────────────────────────────────────

const FETCH_MAX_BYTES = 50 * 1024; // 50 KB
const FETCH_TIMEOUT_MS = 10_000;   // 10 s

function httpsGet(
  url: string,
  headers: Record<string, string> = {},
  maxBytes = Infinity,
  timeoutMs = 10_000
): Promise<string> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const options = {
      hostname: parsed.hostname,
      path: parsed.pathname + parsed.search,
      method: "GET",
      headers: { "Accept": "application/json", "User-Agent": "Lliam/1.0", ...headers },
      timeout: timeoutMs,
    };

    const req = request(options, (res) => {
      let data = "";
      let bytesReceived = 0;

      res.on("data", (chunk: Buffer | string) => {
        const bytes = typeof chunk === "string" ? Buffer.byteLength(chunk) : chunk.length;
        bytesReceived += bytes;

        if (bytesReceived > maxBytes) {
          req.destroy();
          // Resolve with what we have rather than erroring — caller can truncate
          resolve(data);
          return;
        }

        data += chunk;
      });

      res.on("end", () => resolve(data));
    });

    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("Request timed out")); });
    req.end();
  });
}

// ─── Search Backends ──────────────────────────────────────────────────────────

interface SearchResult {
  title: string;
  url: string;
  snippet: string;
  age?: string;
}

async function braveSearch(query: string, apiKey: string, count: number): Promise<SearchResult[]> {
  const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${count}&text_decorations=0`;
  const raw = await httpsGet(url, { "X-Subscription-Token": apiKey });
  const data = JSON.parse(raw);
  const results = data?.web?.results ?? [];
  return results.map((r: Record<string, unknown>) => ({
    title: String(r.title ?? ""),
    url: String(r.url ?? ""),
    snippet: String(r.description ?? ""),
    age: r.age ? String(r.age) : undefined,
  }));
}

async function ddgSearch(query: string, count: number): Promise<SearchResult[]> {
  // DDG Instant Answer API — limited but keyless
  const url = `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_redirect=1&no_html=1`;
  const raw = await httpsGet(url);
  const data = JSON.parse(raw);

  const results: SearchResult[] = [];

  // Abstract (top result)
  if (data.Abstract) {
    results.push({
      title: String(data.Heading ?? query),
      url: String(data.AbstractURL ?? ""),
      snippet: String(data.Abstract).slice(0, 400),
    });
  }

  // Related topics
  const topics: Record<string, unknown>[] = data.RelatedTopics ?? [];
  for (const t of topics.slice(0, count - results.length)) {
    if (t.Text && t.FirstURL) {
      results.push({
        title: String(t.Text).slice(0, 80),
        url: String(t.FirstURL),
        snippet: String(t.Text).slice(0, 300),
      });
    }
  }

  return results.slice(0, count);
}

// ─── Rate-limit state ─────────────────────────────────────────────────────────

/**
 * Returns "YYYY-MM-DD" in local time — used as the daily-reset key.
 */
function todayKey(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

// ─── Plugin ───────────────────────────────────────────────────────────────────

const webSearchPlugin: PluginModule = {
  id: "executive.web-search",
  name: "Web Search",
  version: "1.0.0",
  description: "Real-time web search via Brave Search API (DDG fallback)",

  register(api: PluginAPI) {
    const config = api.pluginConfig as {
      braveApiKey?: string;
      maxResults?: number;
      maxDailySearches?: number;
      maxSessionSearches?: number;
    };

    const braveKey = config.braveApiKey ?? process.env.BRAVE_API_KEY ?? "";
    const maxResults = config.maxResults ?? 5;
    const maxDailySearches = config.maxDailySearches ?? 20;
    const maxSessionSearches = config.maxSessionSearches ?? 5;

    if (!braveKey) {
      api.logger.warn("BRAVE_API_KEY not set — falling back to DuckDuckGo (limited results)");
    } else {
      api.logger.info("Web Search using Brave Search API");
    }

    // ── Per-instance rate-limit trackers ──────────────────────────────────────
    // Session counter — resets when this plugin instance is re-created (process restart)
    let sessionSearchCount = 0;

    // Daily counter — keyed by calendar date so it auto-resets at midnight
    let dailyKey = todayKey();
    let dailySearchCount = 0;

    // Timestamp of the last web_search call (ms) — enforces minimum delay
    let lastSearchTime = 0;

    /**
     * Check and enforce all search caps/rate limits.
     * Returns an error string if a limit is hit, or null if the call may proceed.
     * When null is returned, call `recordSearch()` after the search completes.
     */
    function checkLimits(): string | null {
      // Roll daily counter over at midnight
      const today = todayKey();
      if (today !== dailyKey) {
        dailyKey = today;
        dailySearchCount = 0;
      }

      if (dailySearchCount >= maxDailySearches) {
        return (
          `Daily search limit reached (${maxDailySearches} searches/day). ` +
          `The counter resets at midnight. Try again tomorrow or ask Jerome to raise maxDailySearches in plugin config.`
        );
      }

      if (sessionSearchCount >= maxSessionSearches) {
        return (
          `Session search limit reached (${maxSessionSearches} searches/session). ` +
          `Restart Lliam to reset the session counter, or ask Jerome to raise maxSessionSearches in plugin config.`
        );
      }

      const msSinceLast = Date.now() - lastSearchTime;
      if (lastSearchTime > 0 && msSinceLast < 1000) {
        return (
          `Rate limit: searches must be at least 1 second apart ` +
          `(${Math.ceil((1000 - msSinceLast) / 1000)}s remaining). Please retry momentarily.`
        );
      }

      return null;
    }

    function recordSearch(): void {
      sessionSearchCount++;
      dailySearchCount++;
      lastSearchTime = Date.now();
    }

    // ── web_search ────────────────────────────────────────────────────────────
    api.registerTool({
      name: "web_search",
      description: [
        "Search the web for current information. Use when:",
        "- Jerome asks about current events, news, or recent data",
        "- The answer may have changed since training cutoff",
        "- Research on a specific person, company, regulation, or topic is needed",
        "Returns ranked results with title, URL, and snippet.",
        `Limits: ${maxSessionSearches} searches/session, ${maxDailySearches}/day, 1 search/second minimum.`,
      ].join("\n"),
      parameters: {
        type: "object" as const,
        properties: {
          query: {
            type: "string",
            description: "Search query — be specific, use keywords",
          },
          count: {
            type: "number",
            description: `Number of results to return (default: ${maxResults}, max: 10)`,
          },
        },
        required: ["query"],
      },
      async execute(_id, params) {
        const query = String(params.query);
        const count = Math.min(Number(params.count ?? maxResults), 10);

        const limitError = checkLimits();
        if (limitError) {
          return {
            content: JSON.stringify({ error: limitError, query }),
            isError: true,
          };
        }

        try {
          let results: SearchResult[];
          if (braveKey) {
            results = await braveSearch(query, braveKey, count);
          } else {
            results = await ddgSearch(query, count);
          }

          recordSearch();

          return {
            content: JSON.stringify({
              query,
              result_count: results.length,
              backend: braveKey ? "brave" : "duckduckgo",
              session_searches_used: sessionSearchCount,
              session_searches_remaining: maxSessionSearches - sessionSearchCount,
              daily_searches_used: dailySearchCount,
              results,
            }, null, 2),
          };
        } catch (err) {
          return {
            content: JSON.stringify({
              error: err instanceof Error ? err.message : String(err),
              query,
            }),
          };
        }
      },
    });

    // ── fetch_page ────────────────────────────────────────────────────────────
    api.registerTool({
      name: "fetch_page",
      description: [
        "Fetch the text content of a webpage URL.",
        "Use after web_search when you need to read the full article or page.",
        `Returns extracted plain text (max ${FETCH_MAX_BYTES / 1024}KB, 10s timeout).`,
      ].join(" "),
      parameters: {
        type: "object" as const,
        properties: {
          url: { type: "string", description: "URL to fetch" },
        },
        required: ["url"],
      },
      async execute(_id, params) {
        const url = String(params.url);
        try {
          // Validate URL is http/https
          const parsed = new URL(url);
          if (!["http:", "https:"].includes(parsed.protocol)) {
            return { content: JSON.stringify({ error: "Only http/https URLs are supported" }) };
          }

          const raw = await httpsGet(
            url,
            { "Accept": "text/html,application/xhtml+xml" },
            FETCH_MAX_BYTES,
            FETCH_TIMEOUT_MS
          );

          // Strip HTML tags for readable text
          const text = raw
            .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
            .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
            .replace(/<[^>]+>/g, " ")
            .replace(/\s{2,}/g, " ")
            .trim()
            .slice(0, 3000);

          return { content: JSON.stringify({ url, text_length: text.length, text }) };
        } catch (err) {
          return {
            content: JSON.stringify({
              error: err instanceof Error ? err.message : String(err),
              url,
            }),
          };
        }
      },
    });

    api.logger.info(`Web Search plugin registered (backend: ${braveKey ? "Brave" : "DuckDuckGo"}, limits: ${maxSessionSearches}/session, ${maxDailySearches}/day)`);
  },
};

export default webSearchPlugin;
