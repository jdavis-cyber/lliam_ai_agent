# Lliam — AI Project & Program Management Intelligence

A practitioner-built AI agent platform that brings PMI-aligned project management intelligence to enterprise teams. Built on a secure, local-first architecture with an encrypted knowledge layer that indexes your organization's licensed standards library.

> **Audience:** Enterprise project managers, PMOs, and regulated-industry delivery teams who need AI-augmented PM capabilities without routing sensitive project data through third-party cloud services.

---

## What Problem This Solves

Enterprise PM tools give you templates. They don't give you judgment. When a project manager needs to assess whether a risk warrants a transfer or mitigation response, or how to frame a stakeholder engagement strategy for a resistant executive, the answer isn't in a dropdown — it's in the accumulated body of PMI standards, your organization's methodology documentation, and the practitioner's judgment.

Lliam connects those three things:

1. **Your organization's licensed library** — PMBOK, PRINCE2, SAFe, internal playbooks — indexed locally and made searchable via semantic vector search
2. **PMI ontology** — built-in, always available — process groups, knowledge areas, risk categories, EVM formulas, stakeholder engagement levels
3. **Claude** — to synthesize, generate, and advise using both

Nothing leaves your device unless you configure it to.

---

## What It Does

### PM Knowledge Base

The knowledge layer is the foundation. Configure `knowledgeBasePath` to point at your organization's licensed standards directory. Lliam recursively indexes PDFs, Markdown, and text files using Transformers.js (`all-MiniLM-L6-v2`) — on-device embeddings, no API calls. The index is stored in encrypted SQLite (AES-256-GCM).

| Tool | Description |
|------|-------------|
| `search_knowledge_base` | Semantic search over indexed documents with source attribution |
| `lookup_pm_concept` | Structured lookup against built-in PMI ontology |
| `list_indexed_sources` | Inventory of indexed documents with chunk counts and timestamps |

### PM Documents

Eight tools for generating PMI-aligned project artifacts as structured Markdown:

| Tool | Artifact |
|------|----------|
| `generate_project_charter` | Formal project authorization document |
| `generate_risk_register` | Initial risk log with PMI-aligned columns |
| `generate_raci_matrix` | Responsibility assignment matrix |
| `generate_stakeholder_engagement_plan` | Engagement level mapping and communication cadence |
| `generate_status_report` | RAG health indicators, accomplishments, issues, risks |
| `generate_wbs_dictionary` | Work package definitions with acceptance criteria |
| `generate_lessons_learned` | Phase closeout register with action items |
| `generate_change_request` | CCB-ready change request with impact assessment |

Artifacts are saved to the configured `outputPath` and returned inline for immediate use.

### PM Risk Intelligence

Seven tools covering the full PMI risk lifecycle and portfolio aggregation:

| Tool | Description |
|------|-------------|
| `identify_risks` | Category-structured risk identification using PMI taxonomy |
| `analyze_risk` | P×I scoring, matrix position, strategy recommendation, optional EMV |
| `plan_risk_response` | Action plan, residual risk estimate, contingency plan |
| `create_risk_register` | Full register with scores, sorting, and summary stats |
| `monitor_risks` | Trend analysis (Improving/Worsening/Stable), escalation flags |
| `simulate_risk_monte_carlo` | Probabilistic modeling (PERT/triangular), P10–P90 confidence intervals |
| `aggregate_portfolio_risks` | Multi-project portfolio dashboard, cross-project correlation, category concentration |

### Email & Calendar Briefing

`daily_brief` — pulls unread Gmail and Google Calendar events via GWS CLI. No credentials stored in the plugin; authentication delegates to the user's existing GWS CLI session.

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                        Entry Points                             │
│   CLI chat · WebSocket gateway · Telegram · iMessage           │
└──────────────────────────┬──────────────────────────────────────┘
                           │
┌──────────────────────────▼──────────────────────────────────────┐
│                    AgentRunner (core)                            │
│  before_agent_start hooks → Claude API → tool_use loop          │
│  → ToolExecutor → before/after_tool_call hooks → results        │
└──────┬──────────────────────────────┬───────────────────────────┘
       │                              │
┌──────▼──────┐             ┌─────────▼──────────┐
│  HookRunner │             │   PluginRegistry   │
│  (sequential│             │  Tools · Hooks ·   │
│  + parallel)│             │  Commands · Svc    │
└─────────────┘             └────────────────────┘
       │
┌──────▼──────────────────────────────────────────────────────────┐
│                    Executive Plugins                             │
│  Email & Calendar Briefing · PM Knowledge Base                  │
│  PM Documents · PM Risk Intelligence · Web Search               │
│  NotebookLM · Gemini Voice                                      │
└──────┬──────────────────────────────────────────────────────────┘
       │
┌──────▼──────────────────────────────────────────────────────────┐
│                    Knowledge Layer                               │
│                                                                  │
│  knowledgeBasePath ──► File Discovery (.pdf/.md/.txt)           │
│                              │                                   │
│                    Transformers.js (ONNX)                        │
│                    all-MiniLM-L6-v2 · on-device                 │
│                              │                                   │
│                    Encrypted SQLite (sql.js)                     │
│                    AES-256-GCM · 800-char chunks                 │
│                              │                                   │
│                    Cosine Similarity Search                      │
│                    + PMI Ontology (built-in)                     │
└─────────────────────────────────────────────────────────────────┘
       │
┌──────▼──────────────────────────────────────────────────────────┐
│                    Memory System                                 │
│  WASM SQLite (sql.js) · Hybrid vector + keyword search          │
│  Transformers.js embeddings · Local only                        │
└─────────────────────────────────────────────────────────────────┘
```

### Key design decisions

The gateway binds to `127.0.0.1` only. Nothing is reachable from outside the machine unless the operator explicitly proxies it.

The plugin loader uses manifest validation before importing any code. Failed plugins are isolated — they log a diagnostic and don't crash the runtime.

Knowledge embeddings and memory embeddings are generated in-process via ONNX Runtime. No text leaves the device for embedding. The SQLite database is WASM-compiled with no native dependencies.

---

## Knowledge Base Configuration

Lliam does not ship any licensed PM content. The knowledge base is designed around the **bring-your-own-library model**: your organization configures `knowledgeBasePath` to point at a directory containing its licensed standards, and Lliam indexes it locally.

**Supported file formats:** PDF (requires `npm install pdf-parse`), Markdown, plain text.

**What to put there:**
- PMBOK Guide (organization's licensed copy)
- PRINCE2 or SAFe documentation
- Internal delivery playbooks and methodology guides
- SOW templates, risk threshold policies, governance frameworks

**Configuration** (in your Lliam config):
```json
{
  "plugins": {
    "executive.pm-knowledge": {
      "knowledgeBasePath": "/path/to/your/standards-library",
      "chunkSize": 800,
      "chunkOverlap": 150,
      "reindexOnStart": false
    },
    "executive.pm-documents": {
      "outputPath": "./pm-artifacts",
      "defaultFormat": "markdown"
    }
  }
}
```

**Incremental indexing:** On startup, Lliam checks file modification times and only re-indexes changed files. Set `reindexOnStart: true` to force a full re-index.

**PMI Ontology (always available):** Even without a `knowledgeBasePath`, the built-in PMI ontology is available via `lookup_pm_concept`. It covers all PMBOK process groups, knowledge areas, risk categories, EVM formulas, and stakeholder engagement levels.

---

## Plugin Sandboxing

User-installed plugins (from `~/.lliam/plugins/`) run in V8 isolates via [`isolated-vm`](https://github.com/nicknisi/isolated-vm) by default. This provides:

- **Memory isolation** — each user plugin gets its own V8 heap with a configurable memory limit (default 128MB)
- **No Node.js access** — sandboxed plugins cannot access the filesystem, network, or `require()`/`import` Node.js modules
- **Timeout enforcement** — registration (5s) and tool execution (30s) are capped to prevent runaway code
- **Bridge-only API** — plugins interact solely through the `pluginAPI` bridge: `registerTool`, `registerHook`, `registerCommand`, `log`, and `config`

**Bundled plugins** (in `plugins/core/` and `plugins/executive/`) are trusted and always run in the main process.

**Installation:**
```bash
npm install isolated-vm   # optional — user plugins fall back to unsandboxed without it
```

**Plugin manifest opt-out:**
```json
{
  "sandbox": {
    "enabled": false,
    "memoryLimitMB": 256
  }
}
```

If `isolated-vm` is not installed, user plugins load unsandboxed with a warning diagnostic.

---

## Security Design

| Control | Implementation |
|---|---|
| Authentication | `crypto.timingSafeEqual()` — constant-time even on length mismatch |
| Gateway binding | `127.0.0.1` only — no external exposure by default |
| Channel allowlists | Sender ID validation before any message is processed |
| Input validation | Zod schemas on all inputs at gateway and plugin layers |
| Encryption at rest | AES-256-GCM (KeyManager) — knowledge DB + memory DB + sessions |
| Atomic writes | Temp-file-then-rename prevents data corruption on crash |
| Local embeddings | ONNX Runtime in-process — no external embedding service |
| Plugin isolation | User plugins run in `isolated-vm` V8 isolates with memory limits; bundled plugins are trusted |
| Credential handling | Environment-only; no credentials in config files or code |
| Tool call auditing | Every tool invocation logged with duration and caller context |

### Compliance alignment

| Standard | How addressed |
|---|---|
| NIST AI RMF 1.0 | Govern, Map, Measure, Manage functions in plugin lifecycle, tool audit logging, and risk register |
| ISO 42001 | AI management system controls in plugin sandboxing design and data minimization |
| ISO 27001 | Access control (allowlists, API key auth), audit logging (ToolExecutor), incident response hooks |

---

## Technology Stack

| Layer | Technology |
|---|---|
| Runtime | Node.js 22 (ESM) |
| Language | TypeScript 5.7 (strict mode) |
| AI API | Anthropic Claude SDK (`@anthropic-ai/sdk`) |
| Database | `sql.js` — WASM-compiled SQLite, in-process |
| Embeddings | `Transformers.js` — all-MiniLM-L6-v2, local ONNX |
| Validation | `Zod` — runtime schema enforcement |
| Gateway | Express 5 + `ws` WebSocket server |
| Voice | Gemini 3.1 Flash Live (WebSocket audio, function calling) |
| GWS integration | GWS CLI — Gmail, Calendar, Drive; Google Drive MCP (NotebookLM delegation) |
| Telegram | `grammy` — Bot API, long polling, contact allowlist |
| Testing | Vitest (280+ tests) |

---

## Plugin System

Plugins are discovered from `plugins/core/` and `plugins/executive/` at startup, plus `~/.lliam/plugins/` for user-installed extensions. Each plugin directory contains:

- `lliam.plugin.json` — manifest (id, version, dependencies, configSchema)
- `index.ts` — registers tools, hooks, commands, and services via `PluginAPI`

The `PluginAPI` surface:

```typescript
api.registerTool({ name, description, parameters, execute })
api.registerHook("before_agent_start", handler, { priority })
api.registerService({ id, start, stop })
api.registerCommand({ name, execute })
api.getService("pm-knowledge")
api.logger.info(...)
```

Inter-plugin dependencies are declared in `lliam.plugin.json` and resolved at load time. The PM Documents and PM Risk plugins declare a dependency on `executive.pm-knowledge`, ensuring the knowledge service is initialized before they register their tools.

---

## Running Lliam

```bash
# Prerequisites
node >= 22
npm install

# Optional: PDF indexing support
npm install pdf-parse

# Required
export ANTHROPIC_API_KEY=sk-ant-...

# Optional capabilities
export BRAVE_API_KEY=BSA...       # Web search (DDG fallback if unset)
export GEMINI_API_KEY=...         # Voice channel
export TELEGRAM_BOT_TOKEN=...     # Telegram channel (grammy)

# Gateway server with full plugin system
npm run start

# Interactive CLI (direct Claude, no plugins)
npm run chat
```

The gateway starts on `http://127.0.0.1:3000`. Connect via WebSocket at `ws://127.0.0.1:3000/ws`.

---

## Roadmap

- [x] Plugin sandboxing — `isolated-vm` V8 isolates for user-installed plugins
- [x] Dependency scanning — `npm audit` (high/critical) + socket.dev supply chain scan in CI
- [x] Monte Carlo simulation — PERT/triangular distributions, P10–P90 confidence intervals
- [x] Voice phone integration — Twilio Media Streams → Gemini Live (mulaw/PCM16 transcoding)
- [x] Multi-project portfolio risk aggregation — dashboard, cross-project correlation, category concentration

---

## Author

Built by Jerome Davis — Senior Program Manager and AI Governance Strategist (PMI-CPMAI, ISO 42001, NIST AI RMF).

[LinkedIn](https://www.linkedin.com/in/jdavis-cyber)

---

MIT License
