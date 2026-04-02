/**
 * Daily Brief Plugin
 *
 * Provides a `daily_brief` tool that Claude can invoke to fetch:
 *   - Unread Gmail messages (via GWS CLI: gws gmail list --unread)
 *   - Today's Google Calendar events (via GWS CLI: gws calendar events list)
 *
 * Returns a structured JSON object that Claude synthesizes into a morning brief.
 *
 * Security: No credentials stored in plugin. GWS CLI reads from
 * ~/.config/gws/credentials.enc using the user's existing auth session.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { PluginModule, PluginAPI } from "../../../src/plugin/types.js";

const execFileAsync = promisify(execFile);

// ─── GWS CLI Helpers ─────────────────────────────────────────────────────────

const execFileAsync = promisify(execFile);

async function runGws(args: string[]): Promise<{ stdout: string; error?: string }> {
  try {
    const { stdout } = await execFileAsync("gws", args, {
      timeout: 15_000,
      env: process.env,
    });
    return { stdout: stdout.trim() };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { stdout: "", error: msg };
  }
}

async function fetchUnreadEmails(maxEmails: number): Promise<{
  emails: Array<{ from: string; subject: string; snippet: string; date: string }>;
  error?: string;
}> {
  const { stdout, error } = await runGws([
    "gmail", "list", "--unread",
    "--max-results", String(maxEmails),
    "--format", "json",
  ]);

  if (error || !stdout) {
    return { emails: [], error: error ?? "No output from gws gmail list" };
  }

  try {
    const parsed = JSON.parse(stdout);
    const messages = Array.isArray(parsed) ? parsed : (parsed.messages ?? []);
    return {
      emails: messages.map((m: Record<string, unknown>) => ({
        from: String(m.from ?? m.sender ?? ""),
        subject: String(m.subject ?? "(no subject)"),
        snippet: String(m.snippet ?? m.body ?? "").slice(0, 200),
        date: String(m.date ?? m.receivedAt ?? ""),
      })),
    };
  } catch {
    return {
      emails: [{ from: "GWS CLI", subject: "Raw output", snippet: stdout.slice(0, 500), date: "" }],
    };
  }
}

async function fetchCalendarEvents(lookAheadDays: number): Promise<{
  events: Array<{ title: string; start: string; end: string; location?: string; description?: string }>;
  error?: string;
}> {
  const now = new Date();
  const end = new Date(now);
  end.setDate(end.getDate() + lookAheadDays);

  const { stdout, error } = await runGws([
    "calendar", "events", "list",
    "--time-min", now.toISOString(),
    "--time-max", end.toISOString(),
    "--format", "json",
  ]);

  if (error || !stdout) {
    return { events: [], error: error ?? "No output from gws calendar events list" };
  }

  try {
    const parsed = JSON.parse(stdout);
    const items = Array.isArray(parsed) ? parsed : (parsed.items ?? parsed.events ?? []);
    return {
      events: items.map((e: Record<string, unknown>) => ({
        title: String(e.summary ?? e.title ?? "(untitled)"),
        start: String(
          (e.start as Record<string, string>)?.dateTime ??
          (e.start as Record<string, string>)?.date ?? ""
        ),
        end: String(
          (e.end as Record<string, string>)?.dateTime ??
          (e.end as Record<string, string>)?.date ?? ""
        ),
        location: e.location ? String(e.location) : undefined,
        description: e.description ? String(e.description).slice(0, 300) : undefined,
      })),
    };
  } catch {
    return {
      events: [{ title: "Raw output", start: "", end: "", description: stdout.slice(0, 500) }],
    };
  }
}

// ─── Plugin Definition ────────────────────────────────────────────────────────

const dailyBriefPlugin: PluginModule = {
  id: "executive.daily-brief",
  name: "Daily Brief",
  version: "1.0.0",
  description: "Morning briefing from Gmail + Google Calendar via GWS CLI",

  register(api: PluginAPI) {
    const config = api.pluginConfig as {
      lookAheadDays?: number;
      maxEmails?: number;
    };

    const lookAheadDays = config.lookAheadDays ?? 1;
    const maxEmails = config.maxEmails ?? 10;

    api.registerTool({
      name: "daily_brief",
      description: [
        "Fetch a structured morning brief containing:",
        "- Unread Gmail messages (from, subject, snippet, date)",
        "- Google Calendar events for today and upcoming days",
        "Call this when the user asks for their morning brief, daily update, ",
        "what's on their plate today, or any variant of a daily status check.",
      ].join("\n"),
      parameters: {
        type: "object" as const,
        properties: {
          include_email: {
            type: "boolean",
            description: "Include unread email summary (default: true)",
          },
          include_calendar: {
            type: "boolean",
            description: "Include calendar events (default: true)",
          },
        },
        required: [],
      },
      async execute(_toolCallId: string, params: Record<string, unknown>) {
        const includeEmail = params.include_email !== false;
        const includeCalendar = params.include_calendar !== false;

        const [emailResult, calendarResult] = await Promise.all([
          includeEmail ? fetchUnreadEmails(maxEmails) : Promise.resolve({ emails: [] }),
          includeCalendar ? fetchCalendarEvents(lookAheadDays) : Promise.resolve({ events: [] }),
        ]);

        const briefDate = new Date().toLocaleDateString("en-US", {
          weekday: "long", year: "numeric", month: "long", day: "numeric",
        });

        return {
          content: JSON.stringify({
            date: briefDate,
            email: {
              unread_count: emailResult.emails.length,
              messages: emailResult.emails,
              error: emailResult.error,
            },
            calendar: {
              event_count: calendarResult.events.length,
              events: calendarResult.events,
              look_ahead_days: lookAheadDays,
              error: calendarResult.error,
            },
          }, null, 2),
        };
      },
    });

    api.logger.info("Daily Brief plugin registered (GWS CLI: Gmail + Calendar)");
  },
};

export default dailyBriefPlugin;
