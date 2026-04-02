/**
 * Fitness & Diet Logger Plugin
 *
 * Accepts natural language workout and meal descriptions (voice-friendly).
 * Stores entries in MemoryManager for cross-session persistence.
 *
 * Tools:
 *   - log_workout  — record a workout session
 *   - log_meal     — record a meal or food intake
 *   - log_metric   — record body metric (weight, sleep, etc.)
 *   - get_fitness_summary — pull recent entries and progress
 */

import type { PluginModule, PluginAPI } from "../../../src/plugin/types.js";

interface WorkoutEntry {
  id: string;
  date: string;
  description: string;        // natural language, e.g. "5 min elliptical, 3x10 bench press"
  duration_minutes?: number;
  type?: string;              // cardio, strength, mobility, etc.
  notes?: string;
  logged_at: string;
}

interface MealEntry {
  id: string;
  date: string;
  meal_type: string;          // breakfast, lunch, dinner, snack
  description: string;
  calories?: number;
  notes?: string;
  logged_at: string;
}

interface MetricEntry {
  id: string;
  date: string;
  metric: string;             // weight, sleep_hours, body_fat, etc.
  value: number;
  unit: string;
  logged_at: string;
}

// In-memory store (persisted to MemoryManager on write)
const workouts: WorkoutEntry[] = [];
const meals: MealEntry[] = [];
const metrics: MetricEntry[] = [];

function makeId(prefix: string): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
}

function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

const fitnessPlugin: PluginModule = {
  id: "executive.fitness",
  name: "Fitness & Diet Logger",
  version: "1.0.0",
  description: "Log workouts, meals, and body metrics with natural language input",

  register(api: PluginAPI) {

    // ── log_workout ──────────────────────────────────────────────────────────
    api.registerTool({
      name: "log_workout",
      description: [
        "Log a workout session. Accepts natural language — no rigid format required.",
        "Examples: 'This morning: 5 mins elliptical, 3 sets of 10 bench press at 135lbs, 20 pushups'",
        "or 'Upper body day, about 45 minutes, felt strong'.",
        "Call when Jerome describes a workout, gym session, or any physical activity.",
      ].join(" "),
      parameters: {
        type: "object" as const,
        properties: {
          description: {
            type: "string",
            description: "Natural language description of the workout",
          },
          type: {
            type: "string",
            enum: ["strength", "cardio", "mobility", "hiit", "sport", "general"],
            description: "Workout category (default: general)",
          },
          duration_minutes: {
            type: "number",
            description: "Duration in minutes if known",
          },
          date: {
            type: "string",
            description: "Date of workout (default: today, ISO format YYYY-MM-DD)",
          },
          notes: { type: "string", description: "Any additional notes" },
        },
        required: ["description"],
      },
      async execute(_id, params) {
        const entry: WorkoutEntry = {
          id: makeId("w"),
          date: params.date ? String(params.date) : todayISO(),
          description: String(params.description),
          type: params.type ? String(params.type) : "general",
          duration_minutes: params.duration_minutes ? Number(params.duration_minutes) : undefined,
          notes: params.notes ? String(params.notes) : undefined,
          logged_at: new Date().toISOString(),
        };
        workouts.push(entry);

        try {
          const memMgr = api.getService?.("memory-manager") as { store?: (opts: object) => Promise<void> } | undefined;
          await memMgr?.store?.({
            content: `WORKOUT [${entry.date}]: ${entry.description}${entry.duration_minutes ? ` (${entry.duration_minutes}min)` : ""}`,
            type: "observation",
            metadata: { entryType: "workout", ...entry },
          });
        } catch {
          api.logger.warn("Memory unavailable — workout saved in-session only");
        }

        return { content: JSON.stringify({ status: "logged", entry }) };
      },
    });

    // ── log_meal ─────────────────────────────────────────────────────────────
    api.registerTool({
      name: "log_meal",
      description: [
        "Log a meal or food intake. Natural language welcome.",
        "Call when Jerome describes what he ate, is eating, or plans to eat for tracking.",
      ].join(" "),
      parameters: {
        type: "object" as const,
        properties: {
          description: { type: "string", description: "What was eaten" },
          meal_type: {
            type: "string",
            enum: ["breakfast", "lunch", "dinner", "snack", "drink"],
            description: "Type of meal (default: snack if unclear)",
          },
          calories: { type: "number", description: "Approximate calories if known" },
          date: { type: "string", description: "Date (default: today)" },
          notes: { type: "string", description: "Notes (how it felt, substitutions, etc.)" },
        },
        required: ["description"],
      },
      async execute(_id, params) {
        const entry: MealEntry = {
          id: makeId("m"),
          date: params.date ? String(params.date) : todayISO(),
          meal_type: params.meal_type ? String(params.meal_type) : "snack",
          description: String(params.description),
          calories: params.calories ? Number(params.calories) : undefined,
          notes: params.notes ? String(params.notes) : undefined,
          logged_at: new Date().toISOString(),
        };
        meals.push(entry);

        try {
          const memMgr = api.getService?.("memory-manager") as { store?: (opts: object) => Promise<void> } | undefined;
          await memMgr?.store?.({
            content: `MEAL [${entry.date}/${entry.meal_type}]: ${entry.description}${entry.calories ? ` (~${entry.calories}cal)` : ""}`,
            type: "observation",
            metadata: { entryType: "meal", ...entry },
          });
        } catch {
          api.logger.warn("Memory unavailable — meal saved in-session only");
        }

        return { content: JSON.stringify({ status: "logged", entry }) };
      },
    });

    // ── log_metric ───────────────────────────────────────────────────────────
    api.registerTool({
      name: "log_metric",
      description: "Log a body or health metric (weight, sleep hours, body fat, resting HR, etc.).",
      parameters: {
        type: "object" as const,
        properties: {
          metric: { type: "string", description: "Metric name (e.g. weight, sleep_hours, body_fat_pct)" },
          value: { type: "number", description: "Numeric value" },
          unit: { type: "string", description: "Unit (e.g. lbs, kg, hours, %)" },
          date: { type: "string", description: "Date (default: today)" },
        },
        required: ["metric", "value", "unit"],
      },
      async execute(_id, params) {
        const entry: MetricEntry = {
          id: makeId("x"),
          date: params.date ? String(params.date) : todayISO(),
          metric: String(params.metric),
          value: Number(params.value),
          unit: String(params.unit),
          logged_at: new Date().toISOString(),
        };
        metrics.push(entry);

        try {
          const memMgr = api.getService?.("memory-manager") as { store?: (opts: object) => Promise<void> } | undefined;
          await memMgr?.store?.({
            content: `METRIC [${entry.date}]: ${entry.metric} = ${entry.value} ${entry.unit}`,
            type: "observation",
            metadata: { entryType: "metric", ...entry },
          });
        } catch {
          api.logger.warn("Memory unavailable — metric saved in-session only");
        }

        return { content: JSON.stringify({ status: "logged", entry }) };
      },
    });

    // ── get_fitness_summary ──────────────────────────────────────────────────
    api.registerTool({
      name: "get_fitness_summary",
      description: [
        "Get a summary of recent workouts, meals, and metrics.",
        "Call when Jerome asks about his fitness progress, recent workouts, ",
        "what he's eaten, or wants a health check-in.",
      ].join(" "),
      parameters: {
        type: "object" as const,
        properties: {
          days: {
            type: "number",
            description: "How many days back to include (default: 7)",
          },
        },
        required: [],
      },
      async execute(_id, params) {
        const days = params.days ? Number(params.days) : 7;
        const cutoff = new Date();
        cutoff.setDate(cutoff.getDate() - days);
        const cutoffStr = cutoff.toISOString().slice(0, 10);

        const recentWorkouts = workouts.filter((w) => w.date >= cutoffStr);
        const recentMeals = meals.filter((m) => m.date >= cutoffStr);
        const recentMetrics = metrics.filter((m) => m.date >= cutoffStr);

        return {
          content: JSON.stringify({
            period: `Last ${days} days (since ${cutoffStr})`,
            workouts: { count: recentWorkouts.length, entries: recentWorkouts },
            meals: { count: recentMeals.length, entries: recentMeals },
            metrics: { count: recentMetrics.length, entries: recentMetrics },
          }, null, 2),
        };
      },
    });

    api.logger.info("Fitness & Diet Logger registered");
  },
};

export default fitnessPlugin;
