/**
 * NotebookLM Bridge Plugin
 *
 * Provides Claude access to Google NotebookLM operations via Google Drive MCP.
 * NotebookLM doesn't have a public API — this plugin uses a Drive-backed workflow:
 *
 *   1. Stage source documents in a Drive folder (Jerome adds them to NotebookLM)
 *   2. NotebookLM exports summaries/guides back to Drive
 *   3. Lliam reads those outputs via Drive MCP
 *
 * ── MCP Integration Approach ─────────────────────────────────────────────────
 * The plugin system (PluginAPI) does not expose an MCP client — plugins run
 * inside Lliam's Node.js process but have no way to call MCP tools directly.
 *
 * Chosen approach: AGENT DELEGATION PATTERN
 * Each tool returns a structured JSON response with an "mcp_action" field that
 * tells Claude exactly which Google Drive MCP tool to call next and with what
 * parameters. Claude reads this and issues the MCP call in its next step.
 *
 * The Google Drive MCP exposes two tools:
 *   - google_drive_search  — search files by name or query
 *   - google_drive_fetch   — fetch the content of a file by ID or URL
 *
 * For the upload case (stage_for_notebooklm): neither MCP tool supports file
 * upload, so the tool validates the local file and returns human-readable
 * instructions for Jerome to complete the upload manually or via gws CLI.
 *
 * Tools:
 *   - stage_for_notebooklm  — validate a local file and generate upload instructions
 *   - read_notebook_output   — delegate to MCP to search + fetch a notebook export
 *   - list_notebook_sources  — delegate to MCP to list Drive files in staging folder
 */

import { existsSync } from "node:fs";
import { basename } from "node:path";
import type { PluginModule, PluginAPI } from "../../../src/plugin/types.js";

// Drive folder Jerome uses for NotebookLM source staging — configurable
const DEFAULT_NOTEBOOKLM_INBOX = "NotebookLM Inbox";

// ─── Plugin ───────────────────────────────────────────────────────────────────

const notebookLMPlugin: PluginModule = {
  id: "executive.notebooklm",
  name: "NotebookLM Bridge",
  version: "1.0.0",
  description: "Drive-backed NotebookLM workflow integration via Google Drive MCP",

  register(api: PluginAPI) {

    // ── stage_for_notebooklm ──────────────────────────────────────────────────
    api.registerTool({
      name: "stage_for_notebooklm",
      description: [
        "Validate a local file for NotebookLM and generate upload instructions.",
        "Use when Jerome wants to research a document using NotebookLM.",
        "Validates the file exists locally, then returns instructions for Jerome to upload it.",
        "Note: Google Drive MCP does not support file upload — Jerome must upload manually or via gws CLI.",
      ].join(" "),
      parameters: {
        type: "object" as const,
        properties: {
          file_path: {
            type: "string",
            description: "Absolute path to the local file to stage for NotebookLM",
          },
          notebook_name: {
            type: "string",
            description: "Name of the notebook this source is for (used for folder organization)",
          },
          drive_folder: {
            type: "string",
            description: `Target Drive folder name (default: "${DEFAULT_NOTEBOOKLM_INBOX}")`,
          },
        },
        required: ["file_path"],
      },
      async execute(_id, params) {
        const filePath = String(params.file_path);
        const driveFolderName = params.drive_folder ? String(params.drive_folder) : DEFAULT_NOTEBOOKLM_INBOX;
        const notebookName = params.notebook_name ? String(params.notebook_name) : undefined;

        if (!existsSync(filePath)) {
          return {
            content: JSON.stringify({ error: `File not found: ${filePath}` }),
            isError: true,
          };
        }

        const fileName = basename(filePath);

        // Upload is not available through Google Drive MCP (search + fetch only).
        // Return structured instructions for Jerome to complete the upload step.
        return {
          content: JSON.stringify({
            status: "ready_to_stage",
            file: fileName,
            file_path: filePath,
            target_drive_folder: driveFolderName,
            notebook_name: notebookName ?? null,
            upload_required: true,
            upload_instructions: [
              `The Google Drive MCP only supports search and fetch — file upload must be done via gws CLI or manually.`,
              `To upload via gws CLI, run:`,
              `  gws drive +upload "${filePath}"`,
              `Or drag the file into Google Drive at drive.google.com and move it to the '${driveFolderName}' folder.`,
            ].join("\n"),
            next_step: [
              `After uploading, open NotebookLM (notebooklm.google.com), `,
              `create or open your notebook, click 'Add source', `,
              `and select '${fileName}' from Google Drive.`,
              notebookName ? ` Target notebook: "${notebookName}".` : "",
            ].join(""),
          }, null, 2),
        };
      },
    });

    // ── read_notebook_output ──────────────────────────────────────────────────
    api.registerTool({
      name: "read_notebook_output",
      description: [
        "Read a NotebookLM-generated output from Google Drive via MCP.",
        "Use when Jerome has exported a summary, FAQ, study guide, or briefing doc from NotebookLM.",
        "Returns an MCP action for google_drive_search (if searching by name) or google_drive_fetch (if file ID is known).",
      ].join(" "),
      parameters: {
        type: "object" as const,
        properties: {
          file_name: {
            type: "string",
            description: "Partial or full name of the Drive file to find and read",
          },
          drive_file_id: {
            type: "string",
            description: "Drive file ID (if known — use google_drive_fetch directly)",
          },
        },
        required: [],
      },
      async execute(_id, params) {
        const driveFileId = params.drive_file_id ? String(params.drive_file_id) : undefined;
        const fileName = params.file_name ? String(params.file_name) : undefined;

        if (!driveFileId && !fileName) {
          return {
            content: JSON.stringify({ error: "Provide file_name or drive_file_id" }),
            isError: true,
          };
        }

        if (driveFileId) {
          // We have the file ID — delegate to google_drive_fetch directly.
          return {
            content: JSON.stringify({
              mcp_action: {
                description: "File ID is known. Call google_drive_fetch to read the file content.",
                tool: "google_drive_fetch",
                params: { fileId: driveFileId },
                instruction: "Call the google_drive_fetch MCP tool with the params above to retrieve the file content.",
              },
              drive_file_id: driveFileId,
            }, null, 2),
          };
        }

        // No file ID — delegate search first, then fetch.
        return {
          content: JSON.stringify({
            mcp_action: {
              description: "Search for the file by name, then fetch its content.",
              step_1: {
                tool: "google_drive_search",
                params: { query: fileName },
                instruction: `Call google_drive_search with query "${fileName}" to find matching files. ` +
                  "Pick the most relevant result, note its file ID, then call google_drive_fetch with that ID.",
              },
              step_2: {
                tool: "google_drive_fetch",
                params: { fileId: "<file_id_from_step_1>" },
                instruction: "Replace <file_id_from_step_1> with the actual ID returned from google_drive_search.",
              },
            },
            file_name_query: fileName,
          }, null, 2),
        };
      },
    });

    // ── list_notebook_sources ─────────────────────────────────────────────────
    api.registerTool({
      name: "list_notebook_sources",
      description: [
        "List files staged in the NotebookLM Drive inbox folder.",
        "Delegates to the google_drive_search MCP tool to find files in the staging folder.",
      ].join(" "),
      parameters: {
        type: "object" as const,
        properties: {
          drive_folder: {
            type: "string",
            description: `Folder name to list (default: "${DEFAULT_NOTEBOOKLM_INBOX}")`,
          },
        },
        required: [],
      },
      async execute(_id, params) {
        const folderName = params.drive_folder ? String(params.drive_folder) : DEFAULT_NOTEBOOKLM_INBOX;

        // Delegate to google_drive_search MCP tool.
        return {
          content: JSON.stringify({
            mcp_action: {
              description: `List files in the '${folderName}' Drive folder.`,
              tool: "google_drive_search",
              params: { query: `'${folderName}' in parents` },
              instruction: `Call google_drive_search with the params above to list files in '${folderName}'. ` +
                "Summarize the results (name, type, last modified) for Jerome.",
            },
            folder: folderName,
          }, null, 2),
        };
      },
    });

    api.logger.info("NotebookLM Bridge plugin registered (Google Drive MCP — agent delegation pattern)");
  },
};

export default notebookLMPlugin;
