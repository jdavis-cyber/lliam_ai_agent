# Lliam: A Local-First, Secure AI Agent Platform

> **Note:** This project is also referred to as "OpenClaw" or "Lliam AI Agent".

Lliam is a high-security, local-first personal AI assistant built with TypeScript and Node.js. Developed as a practitioner's reflection on AI system security, Lliam demonstrates how to build and audit an AI agent framework with a "Security by Design" philosophy.

## 🚀 Project Overview

Lliam provides a modular framework for AI agents with a focus on:

- **Privacy:** All data stays on your device. Local embeddings and local vector search.
- **Security:** Timing-safe authentication, atomic file writes, and strict input validation.
- **Governance:** Aligned with NIST AI RMF 1.0, ISO 42001, and ISO 27001 standards.

## 🏗️ Architecture

- **Core Agent:** Manages streaming Claude 3.5 Sonnet integration and retry logic.
- **Gateway Server:** Express-based HTTP and WebSocket server for authenticated access.
- **Memory System:** Hybrid vector and keyword search using `sql.js` (WASM SQLite) and `Transformers.js`.
- **Plugin System:** Manifest-based discovery and tool execution.
- **Multi-Channel:** Native adapters for Telegram and iMessage (via BlueBubbles).

## 🛠️ Technology Stack

- **Runtime:** Node.js 22 (ESM)
- **Language:** TypeScript 5.7 (Strict Mode)
- **AI API:** Anthropic Claude SDK
- **Database:** WASM-compiled SQLite (`sql.js`) for in-process storage.
- **Embeddings:** `Transformers.js` (all-MiniLM-L6-v2) for local vector generation.
- **Validation:** `Zod` for runtime schema enforcement
- **Testing:** `Vitest` (280+ automated tests)

## 🔐 Security & Risk Management

### Key Security Features

- **Timing-Safe Auth:** Uses `crypto.timingSafeEqual()` for API key verification to prevent timing attacks.
- **Local Embeddings:** Embeddings are generated in-process (ONNX Runtime); no text is sent to external embedding services.
- **Allowlist Enforcement:** Strict sender allowlisting at the channel level.
- **Atomic Persistence:** Uses temp-file-then-rename pattern to prevent data corruption.
- **Input Validation:** Comprehensive Zod schemas for all inputs.

### Risk Register (Highlights)

- **R1 (Credential Management):** Mitigated via environment-only loading.
- **R4 (Plugin Sandbox):** Currently manifest-validated; execution sandboxing planned for Phase 8.
- **R5 (Memory Privacy):** Prompts designed to exclude PII/PHI with confidence filtering.

## 🧪 Testing

The project includes a robust suite of **280 automated tests** using Vitest, covering:

- Authentication bypass attempts.
- Input boundary enforcement (e.g., 100k character caps).
- Concurrent message deduplication.
- Plugin error isolation.

## 📈 Roadmap

- [ ] **Phase 8:** Encryption at rest for session files and SQLite database.
- [ ] **Phase 8:** Plugin execution sandboxing (isolated-vm).
- [ ] **Phase 8:** Automated dependency vulnerability scanning.

## 📄 License

This project is licensed under the MIT License.
