# Lliam — Local-First AI Executive Assistant Platform

A practitioner-built AI agent platform demonstrating what secure, privacy-respecting AI system design looks like in practice. Built for personal executive assistant use and as a proof-of-work for AI governance and secure agent architecture.

> **Audience:** Federal program managers, regulated-industry leaders, and AI governance practitioners evaluating what it actually takes to build trustworthy AI agents.

---

## What Problem This Solves

Most AI assistant products work by routing your conversations — and your data — through cloud infrastructure you don't control. For anyone operating in a regulated environment, or anyone who simply values data ownership, that's a non-starter.

Lliam runs entirely on your machine. Your prompts, your memories, your tool calls, your calendar data — none of it leaves your device unless you explicitly configure it to. The architecture was designed around that constraint from day one, not bolted on afterward.

---

## What It Does

Lliam is a fully functional personal executive assistant, powered by Claude. It handles:

- **Daily briefs** — pulls unread Gmail and Google Calendar events via GWS CLI, synthesizes a structured morning summary
- **Commitments and errands** — tracks tasks, commitments, and follow-ups across sessions
- **Fitness and diet logging** — accepts natural language workout and meal descriptions; logs metrics over time
- **Web search** — real-time lookup via Brave Search API (no key required for DuckDuckGo fallback)
- **Voice channel** — real-time conversation via Gemini 3.1 Flash Live (WebSocket audio, function calling, barge-in support)

All of these are implemented as plugins. The core agent loop, memory system, and gateway are separate from the capabilities — which means the surface area is auditable and the capabilities are replaceable.

---

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                     Entry Points                            │
│   CLI chat · WebSocket gateway · Telegram · iMessage        │
└──────────────────────┬──────────────────────────────────────┘
                       │
┌──────────────────────▼──────────────────────────────────────┐
│                  AgentRunner (core)                          │
│  before_agent_start hooks → Claude API → tool_use loop      │
│  → ToolExecutor → before/after_tool_call hooks → results    │
└──────┬───────────────────────────┬──────────────────────────┘
       │                           │
┌──────▼──────┐          ┌─────────▼──────────┐
│  HookRunner │          │   PluginRegistry   │
│  (sequential│          │  Tools · Hooks ·   │
│  + parallel)│          │  Commands · Svc    │
└─────────────┘          └────────────────────┘
       │
┌──────▼──────────────────────────────────────────────────────┐
│                  Executive Plugins                           │
│  daily-brief · commitments · fitness · web-search           │
│  gemini-voice                                               │
└─────────────────────────────────────────────────────────────┘
       │
┌──────▼──────────────────────────────────────────────────────┐
│                  Memory System                               │
│  WASM SQLite (sql.js) · Transformers.js embeddings          │
│  Hybrid vector + keyword search · Local only                │
└─────────────────────────────────────────────────────────────┘
```

### Key design decisions

The gateway binds to `127.0.0.1` only. Nothing is reachable from outside the machine unless the operator explicitly proxies it. Channel adapters (Telegram, iMessage via BlueBubbles) connect outbound — the agent doesn't expose a public endpoint.

The plugin loader uses manifest validation before importing any code. Failed plugins are isolated — they log a diagnostic and don't crash the runtime.

Memory embeddings are generated in-process via ONNX Runtime. No text leaves the device for embedding. The SQLite database is WASM-compiled, so it runs in the same Node.js process with no native dependencies.

---

## Security Design

| Control | Implementation |
|---|---|
| Authentication | `crypto.timingSafeEqual()` — constant-time even on length mismatch |
| Gateway binding | `127.0.0.1` only — no external exposure by default |
| Channel allowlists | Sender ID validation before any message is processed |
| Input validation | Zod schemas on all inputs at gateway and plugin layers |
| Atomic writes | Temp-file-then-rename prevents session data corruption |
| Local embeddings | ONNX Runtime in-process — no external embedding service |
| Plugin isolation | Manifest-validated; sandboxing via `isolated-vm` planned (Phase 8) |
| Credential handling | Environment-only; no credentials in config files or code |
| Tool call auditing | Every tool invocation logged with duration and caller context |

### Compliance alignment

The architecture maps to the following standards:

- **NIST AI RMF 1.0** — Govern, Map, Measure, Manage functions addressed in plugin lifecycle, tool audit logging, and risk register
- **ISO 42001** — AI management system controls reflected in plugin sandboxing design and data minimization choices
- **ISO 27001** — Access control (allowlists, API key auth), audit logging (ToolExecutor), and incident response hooks

---

## Technology Stack

| Layer | Technology |
|---|---|
| Runtime | Node.js 22 (ESM) |
| Language | TypeScript 5.7 (strict mode) |
| AI API | Anthropic Claude SDK (`@anthropic-ai/sdk`) |
| Database | `sql.js` — WASM-compiled SQLite, in-process |
| Embeddings | `Transformers.js` — all-MiniLM-L6-v2, local |
| Validation | `Zod` — runtime schema enforcement |
| Gateway | Express 5 + `ws` WebSocket server |
| Voice | Gemini 3.1 Flash Live (`gemini-3.1-flash-live-preview`) |
| GWS integration | GWS CLI — Gmail, Calendar, Drive |
| Testing | Vitest (280+ tests) |

---

## Plugin System

Plugins are discovered from `plugins/core/` and `plugins/executive/` at startup, plus `~/.lliam/plugins/` for user-installed extensions. Each plugin directory contains:

- `lliam.plugin.json` — manifest (id, version, configSchema)
- `index.ts` — registers tools, hooks, commands, and services via `PluginAPI`

The `PluginAPI` surface is narrow by design:

```typescript
api.registerTool({ name, description, parameters, execute })
api.registerHook("before_agent_start", handler, { priority })
api.registerService({ id, start, stop })
api.registerCommand({ name, execute })
api.getService("memory-manager")
api.logger.info(...)
```

Hooks execute in two modes: modifying hooks (sequential, priority-ordered — can inject context or block execution) and fire-and-forget hooks (parallel — errors isolated, never crash the loop).

---

## Running Lliam

```bash
# Prerequisites
node >= 22
npm install

# Set your Anthropic API key
export ANTHROPIC_API_KEY=sk-ant-...

# Optional: Brave Search (web search plugin)
export BRAVE_API_KEY=BSA...

# Optional: Gemini voice channel
export GEMINI_API_KEY=...

# Interactive CLI chat (no plugin system — direct Claude)
npm run chat

# Gateway server with full plugin system (recommended)
npm run start
```

The gateway starts on `http://127.0.0.1:3000`. Connect via WebSocket at `ws://127.0.0.1:3000/ws`.

---

## Roadmap

- [ ] **Phase 8 — Encryption at rest:** AES-256-GCM for session files and SQLite database
- [ ] **Phase 8 — Plugin sandboxing:** `isolated-vm` for third-party plugin execution isolation
- [ ] **Phase 8 — Dependency scanning:** Automated vulnerability scanning in CI
- [ ] **Voice phone integration:** Twilio Media Streams → Gemini Live voice channel
- [ ] **CLI chat → AgentRunner:** Wire `lliam chat` through the plugin system (currently uses Agent directly)

---

## Author

Built by Jerome Davis — Senior Program Manager and AI Governance Strategist.

[LinkedIn](https://www.linkedin.com/in/jdavis-cyber)

---

MIT License
