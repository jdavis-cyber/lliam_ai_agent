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
 *   BRAVE_API_KEY env var — get free key at https://api.search.brave.com/
 */

import { request } from "node:https";
import type { PluginModule, PluginAPI } from "../../../src/plugin/types.js";

// ─── HTTP Helpers ─────────────────────────────────────────────────────────────

function httpsGet(url: string, headers: Record<string, string> = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const options = {
      hostname: parsed.hostname,
      path: parsed.pathname + parsed.search,
      method: "GET",
      headers: { "Accept": "application/json", "User-Agent": "Lliam/1.0", ...headers },
      timeout: 10_000,
    };

    const req = request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => { data += chunk; });
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

// ─── Plugin ───────────────────────────────────────────────────────────────────

const webSearchPlugin: PluginModule = {
  id: "executive.web-search",
  name: "Web Search",
  version: "1.0.0",
  description: "Real-time web search via Brave Search API (DDG fallback)",

  register(api: PluginAPI) {
    const config = api.pluginConfig as { braveApiKey?: string; maxResults?: number };
    const braveKey = config.braveApiKey ?? process.env.BRAVE_API_KEY ?? "";
    const maxResults = config.maxResults ?? 5;

    if (!braveKey) {
      api.logger.warn("BRAVE_API_KEY not set — falling back to DuckDuckGo (limited results)");
    } else {
      api.logger.info("Web Search using Brave Search API");
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

        try {
          let results: SearchResult[];
          if (braveKey) {
            results = await braveSearch(query, braveKey, count);
          } else {
            results = await ddgSearch(query, count);
          }

          return {
            content: JSON.stringify({
              query,
              result_count: results.length,
              backend: braveKey ? "brave" : "duckduckgo",
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
        "Returns extracted plain text (first 3000 characters).",
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

          const raw = await httpsGet(url, { "Accept": "text/html,application/xhtml+xml" });

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

    api.logger.info(`Web Search plugin registered (backend: ${braveKey ? "Brave" : "DuckDuckGo"})`);
  },
};

export default webSearchPlugin;
