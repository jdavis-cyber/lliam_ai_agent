/**
 * Plugin Loader
 *
 * Discovers plugins from filesystem directories, validates their manifests,
 * dynamically imports their modules, and calls register() to populate the registry.
 *
 * Discovery paths (in priority order):
 *   1. Bundled: ./plugins/core/  (shipped with Lliam)
 *   2. User:    ~/.lliam/plugins/ (user-installed)
 *
 * Each plugin directory must contain:
 *   - lliam.plugin.json  (manifest)
 *   - index.ts or index.js (entry point, or as specified in manifest.main)
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { z } from "zod";
import type {
  PluginManifest,
  PluginModule,
  PluginRecord,
  PluginOrigin,
} from "./types.js";
import { PluginRegistry } from "./registry.js";
import { buildPluginAPI } from "./context.js";

// ─── Manifest Validation ────────────────────────────────────────────────────

const ManifestSchema = z.object({
  id: z.string().min(1).regex(/^[a-z0-9][a-z0-9._-]*$/, {
    message: "Plugin ID must be lowercase alphanumeric with dots, hyphens, or underscores",
  }),
  name: z.string().min(1),
  version: z.string().min(1),
  description: z.string().min(1),
  main: z.string().optional(),
  kind: z.enum(["memory", "channel", "browser", "general"]).optional(),
  configSchema: z.record(z.unknown()).optional(),
});

// ─── Plugin Discovery ───────────────────────────────────────────────────────

interface PluginCandidate {
  /** Directory containing the plugin */
  dir: string;

  /** Parsed manifest */
  manifest: PluginManifest;

  /** Where this plugin was found */
  origin: PluginOrigin;
}

/**
 * Scan a directory for plugin subdirectories.
 * Each subdirectory must contain a lliam.plugin.json file.
 */
function discoverPluginsInDir(
  baseDir: string,
  origin: PluginOrigin
): { candidates: PluginCandidate[]; errors: string[] } {
  const candidates: PluginCandidate[] = [];
  const errors: string[] = [];

  if (!existsSync(baseDir)) {
    return { candidates, errors };
  }

  let entries: string[];
  try {
    entries = readdirSync(baseDir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    errors.push(`Failed to read directory: ${baseDir}`);
    return { candidates, errors };
  }

  for (const entry of entries) {
    const pluginDir = join(baseDir, entry);
    const manifestPath = join(pluginDir, "lliam.plugin.json");

    if (!existsSync(manifestPath)) {
      // Not a plugin directory — skip silently
      continue;
    }

    try {
      const raw = readFileSync(manifestPath, "utf-8");
      const parsed = JSON.parse(raw);
      const manifest = ManifestSchema.parse(parsed);

      candidates.push({ dir: pluginDir, manifest, origin });
    } catch (err) {
      const msg =
        err instanceof z.ZodError
          ? `Invalid manifest in ${pluginDir}: ${err.errors.map((e) => e.message).join(", ")}`
          : `Failed to load manifest from ${pluginDir}: ${err instanceof Error ? err.message : String(err)}`;
      errors.push(msg);
    }
  }

  return { candidates, errors };
}

/**
 * Discover all plugins from configured search paths.
 */
export function discoverPlugins(
  searchPaths: { dir: string; origin: PluginOrigin }[]
): { candidates: PluginCandidate[]; errors: string[] } {
  const allCandidates: PluginCandidate[] = [];
  const allErrors: string[] = [];

  for (const { dir, origin } of searchPaths) {
    const resolved = resolve(dir);
    const { candidates, errors } = discoverPluginsInDir(resolved, origin);
    allCandidates.push(...candidates);
    allErrors.push(...errors);
  }

  return { candidates: allCandidates, errors: allErrors };
}

// ─── Plugin Module Loading ──────────────────────────────────────────────────

/**
 * Resolve the entry point for a plugin.
 * Checks manifest.main first, then falls back to index.ts / index.js.
 */
function resolveEntryPoint(pluginDir: string, manifest: PluginManifest): string | null {
  if (manifest.main) {
    const mainPath = join(pluginDir, manifest.main);
    if (existsSync(mainPath)) return mainPath;
  }

  // Try common entry points
  for (const filename of ["index.ts", "index.js"]) {
    const path = join(pluginDir, filename);
    if (existsSync(path)) return path;
  }

  return null;
}

/**
 * Dynamically import a plugin module and extract its exports.
 * Handles both default exports and named exports.
 */
async function loadPluginModule(entryPoint: string): Promise<PluginModule> {
  // Use native import() for ESM modules
  const mod = await import(entryPoint);

  // Handle default export (most common)
  if (mod.default && typeof mod.default === "object" && "register" in mod.default) {
    return mod.default as PluginModule;
  }

  // Handle named exports (less common but supported)
  if (typeof mod.register === "function") {
    return {
      id: mod.id ?? "unknown",
      name: mod.name ?? "Unknown Plugin",
      version: mod.version,
      description: mod.description,
      register: mod.register,
    } as PluginModule;
  }

  throw new Error("Plugin module must export a default object with a register() function");
}

// ─── Main Loader ────────────────────────────────────────────────────────────

export interface LoadPluginsOptions {
  /** Plugin search paths (e.g., [{ dir: "./plugins/core", origin: "bundled" }]) */
  searchPaths: { dir: string; origin: PluginOrigin }[];

  /** Per-plugin configuration from app config (keyed by plugin ID) */
  pluginConfigs?: Record<string, Record<string, unknown>>;

  /** Explicit list of plugin IDs to disable */
  disabledPlugins?: string[];
}

/**
 * Discover, validate, load, and register all plugins.
 *
 * Returns a fully populated PluginRegistry.
 *
 * Loading is fail-safe: individual plugin failures are recorded as diagnostics
 * but don't prevent other plugins from loading.
 */
export async function loadPlugins(
  options: LoadPluginsOptions
): Promise<PluginRegistry> {
  const registry = new PluginRegistry();
  const { searchPaths, pluginConfigs = {}, disabledPlugins = [] } = options;

  // 1. Discover candidates
  const { candidates, errors } = discoverPlugins(searchPaths);

  // Record discovery errors
  for (const err of errors) {
    registry.addDiagnostic("system", "error", err);
  }

  // 2. Deduplicate by ID (later paths override earlier ones)
  const byId = new Map<string, PluginCandidate>();
  for (const candidate of candidates) {
    if (byId.has(candidate.manifest.id)) {
      registry.addDiagnostic(
        candidate.manifest.id,
        "info",
        `Plugin "${candidate.manifest.id}" found in multiple locations — using ${candidate.dir}`
      );
    }
    byId.set(candidate.manifest.id, candidate);
  }

  // 3. Load each plugin
  for (const [pluginId, candidate] of byId) {
    const { manifest, dir, origin } = candidate;

    // Create plugin record
    const record: PluginRecord = {
      id: manifest.id,
      name: manifest.name,
      version: manifest.version,
      description: manifest.description,
      kind: manifest.kind ?? "general",
      source: dir,
      origin,
      enabled: true,
      status: "pending",
      toolNames: [],
      hookNames: [],
    };

    registry.registerPlugin(record);

    // Check if disabled
    if (disabledPlugins.includes(pluginId)) {
      registry.updatePluginStatus(pluginId, "disabled");
      registry.addDiagnostic(pluginId, "info", "Plugin disabled by configuration");
      continue;
    }

    // Resolve entry point
    const entryPoint = resolveEntryPoint(dir, manifest);
    if (!entryPoint) {
      registry.updatePluginStatus(pluginId, "error", "No entry point found");
      registry.addDiagnostic(
        pluginId,
        "error",
        `No entry point found in ${dir} (tried: ${manifest.main ?? "index.ts, index.js"})`
      );
      continue;
    }

    // Load and register
    try {
      const mod = await loadPluginModule(entryPoint);

      // Validate that module ID matches manifest ID
      if (mod.id !== manifest.id) {
        registry.addDiagnostic(
          pluginId,
          "warn",
          `Module ID "${mod.id}" doesn't match manifest ID "${manifest.id}" — using manifest ID`
        );
      }

      // Build scoped API and call register()
      const pluginConfig = pluginConfigs[pluginId] ?? {};
      const api = buildPluginAPI(record, registry, pluginConfig);

      await mod.register(api);

      registry.updatePluginStatus(pluginId, "loaded");
      registry.addDiagnostic(
        pluginId,
        "info",
        `Loaded successfully (${record.toolNames.length} tools, ${record.hookNames.length} hooks)`
      );
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      registry.updatePluginStatus(pluginId, "error", errorMsg);
      registry.addDiagnostic(pluginId, "error", `Failed to load: ${errorMsg}`);
    }
  }

  return registry;
}
