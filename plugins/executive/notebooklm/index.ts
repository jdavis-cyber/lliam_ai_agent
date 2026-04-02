/**
 * NotebookLM Bridge Plugin
 *
 * Provides Claude access to Google NotebookLM operations via GWS CLI.
 * NotebookLM doesn't have a public API — this plugin uses two strategies:
 *
 *   1. GWS CLI (`gws notebooklm ...`) — if Google ever exposes a Workspace API
 *   2. Drive-backed workflow — upload source docs to Drive, then reference
 *      notebook outputs that NotebookLM saves back to Drive
 *
 * This is the realistic, working approach today:
 *   - Use Drive to stage source documents
 *   - Jerome opens NotebookLM, adds the Drive file
 *   - NotebookLM exports summaries/guides back to Drive
 *   - Lliam reads those outputs
 *
 * The plugin surfaces this workflow as clean tool calls so Claude can
 * guide Jerome through it and read the outputs automatically.
 *
 * Tools:
 *   - stage_for_notebooklm — upload a local file to Drive's NotebookLM Inbox
 *   - read_notebook_output — read a NotebookLM export from Drive
 *   - list_notebook_sources — list files staged for NotebookLM
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync } from "node:fs";
import { basename } from "node:path";
import type { PluginModule, PluginAPI } from "../../../src/plugin/types.js";

const execFileAsync = promisify(execFile);

// Drive folder Jerome uses for NotebookLM source staging
// This should match the PARA structure folder — configurable
const DEFAULT_NOTEBOOKLM_INBOX = "NotebookLM Inbox";

async function runGws(args: string[]): Promise<{ stdout: string; error?: string }> {
  try {
    const { stdout } = await execFileAsync("gws", args, {
      timeout: 30_000,
      env: process.env,
    });
    return { stdout: stdout.trim() };
  } catch (err) {
    return { stdout: "", error: err instanceof Error ? err.message : String(err) };
  }
}

const notebookLMPlugin: PluginModule = {
  id: "executive.notebooklm",
  name: "NotebookLM Bridge",
  version: "1.0.0",
  description: "Drive-backed NotebookLM workflow integration via GWS CLI",

  register(api: PluginAPI) {

    // ── stage_for_notebooklm ──────────────────────────────────────────────────
    api.registerTool({
      name: "stage_for_notebooklm",
      description: [
        "Upload a local file to Google Drive so Jerome can add it as a NotebookLM source.",
        "Use when Jerome wants to research a document using NotebookLM — ",
        "PDFs, text files, Google Docs links. Uploads to Drive and returns a shareable link.",
      ].join(" "),
      parameters: {
        type: "object" as const,
        properties: {
          file_path: {
            type: "string",
            description: "Absolute path to the local file to upload",
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

        if (!existsSync(filePath)) {
          return { content: JSON.stringify({ error: `File not found: ${filePath}` }) };
        }

        const fileName = basename(filePath);

        // Try to find or use Drive folder by name
        const { stdout: listOut, error: listErr } = await runGws([
          "drive", "files", "list",
          "--name", driveFolderName,
          "--mime-type", "application/vnd.google-apps.folder",
          "--format", "json",
        ]);

        let folderId: string | undefined;
        if (!listErr && listOut) {
          try {
            const files = JSON.parse(listOut);
            const arr = Array.isArray(files) ? files : (files.files ?? []);
            folderId = arr[0]?.id;
          } catch { /* ignore */ }
        }

        // Upload the file
        const uploadArgs = ["drive", "+upload", filePath];
        if (folderId) uploadArgs.push("--parent", folderId);

        const { stdout: uploadOut, error: uploadErr } = await runGws(uploadArgs);

        if (uploadErr) {
          return { content: JSON.stringify({ error: uploadErr, file: fileName }) };
        }

        return {
          content: JSON.stringify({
            status: "staged",
            file: fileName,
            drive_folder: driveFolderName,
            folder_id: folderId ?? "root",
            gws_output: uploadOut,
            next_step: `Open NotebookLM (notebooklm.google.com), create or open your notebook, click 'Add source', and select '${fileName}' from Google Drive.`,
          }),
        };
      },
    });

    // ── read_notebook_output ──────────────────────────────────────────────────
    api.registerTool({
      name: "read_notebook_output",
      description: [
        "Read a NotebookLM-generated output from Google Drive.",
        "Use when Jerome has exported a summary, FAQ, study guide, or briefing doc from NotebookLM ",
        "and wants Lliam to read and act on it.",
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
            description: "Drive file ID (if known — faster than searching by name)",
          },
        },
        required: [],
      },
      async execute(_id, params) {
        let fileId = params.drive_file_id ? String(params.drive_file_id) : undefined;

        // Search by name if no ID
        if (!fileId && params.file_name) {
          const { stdout, error } = await runGws([
            "drive", "files", "list",
            "--name", String(params.file_name),
            "--format", "json",
          ]);

          if (error || !stdout) {
            return { content: JSON.stringify({ error: error ?? "No output from drive files list" }) };
          }

          try {
            const files = JSON.parse(stdout);
            const arr = Array.isArray(files) ? files : (files.files ?? []);
            fileId = arr[0]?.id;
            if (!fileId) {
              return { content: JSON.stringify({ error: `No file found matching: ${params.file_name}` }) };
            }
          } catch {
            return { content: JSON.stringify({ error: "Failed to parse drive file list" }) };
          }
        }

        if (!fileId) {
          return { content: JSON.stringify({ error: "Provide file_name or drive_file_id" }) };
        }

        // Fetch file content via GWS
        const { stdout: content, error: fetchErr } = await runGws([
          "drive", "files", "export",
          "--file-id", fileId,
          "--mime-type", "text/plain",
        ]);

        if (fetchErr || !content) {
          return { content: JSON.stringify({ error: fetchErr ?? "Empty file content", file_id: fileId }) };
        }

        return {
          content: JSON.stringify({
            file_id: fileId,
            character_count: content.length,
            text: content.slice(0, 8000), // Stay well within context
          }),
        };
      },
    });

    // ── list_notebook_sources ─────────────────────────────────────────────────
    api.registerTool({
      name: "list_notebook_sources",
      description: "List files staged in the NotebookLM Drive inbox folder.",
      parameters: {
        type: "object" as const,
        properties: {
          drive_folder: {
            type: "string",
            description: `Folder to list (default: "${DEFAULT_NOTEBOOKLM_INBOX}")`,
          },
        },
        required: [],
      },
      async execute(_id, params) {
        const folderName = params.drive_folder ? String(params.drive_folder) : DEFAULT_NOTEBOOKLM_INBOX;

        const { stdout, error } = await runGws([
          "drive", "files", "list",
          "--parent-name", folderName,
          "--format", "json",
        ]);

        if (error) {
          return { content: JSON.stringify({ error, folder: folderName }) };
        }

        try {
          const files = JSON.parse(stdout || "[]");
          const arr = Array.isArray(files) ? files : (files.files ?? []);
          return {
            content: JSON.stringify({
              folder: folderName,
              count: arr.length,
              files: arr.map((f: Record<string, unknown>) => ({
                id: f.id,
                name: f.name,
                mimeType: f.mimeType,
                modifiedTime: f.modifiedTime,
              })),
            }, null, 2),
          };
        } catch {
          return { content: JSON.stringify({ raw: stdout, folder: folderName }) };
        }
      },
    });

    api.logger.info("NotebookLM Bridge plugin registered (Drive-backed workflow)");
  },
};

export default notebookLMPlugin;
