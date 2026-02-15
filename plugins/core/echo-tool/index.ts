/**
 * Echo Tool Plugin
 *
 * A simple reference plugin for testing the Lliam plugin system.
 * Demonstrates: tool registration, hook registration, command registration, service registration.
 */

import type { PluginModule, PluginAPI } from "../../../src/plugin/types.js";

const echoPlugin: PluginModule = {
  id: "core.echo",
  name: "Echo Tool",
  version: "1.0.0",
  description: "Echo tool for testing the plugin system",

  register(api: PluginAPI) {
    const config = api.pluginConfig as {
      prefix?: string;
      uppercase?: boolean;
    };

    const prefix = config.prefix ?? "[echo]";
    const uppercase = config.uppercase ?? false;

    // ── Tool: echo ──────────────────────────────────────────────────────
    api.registerTool({
      name: "echo",
      description:
        "Echoes back the provided text. Useful for testing tool execution.",
      parameters: {
        type: "object" as const,
        properties: {
          text: {
            type: "string",
            description: "The text to echo back",
          },
        },
        required: ["text"],
      },
      async execute(_toolCallId: string, params: Record<string, unknown>) {
        const text = params.text as string;
        let result = `${prefix} ${text}`;

        if (uppercase) {
          result = result.toUpperCase();
        }

        return { content: result };
      },
    });

    // ── Tool: reverse ───────────────────────────────────────────────────
    api.registerTool({
      name: "reverse",
      description: "Reverses the provided text. Useful for testing multi-tool plugins.",
      parameters: {
        type: "object" as const,
        properties: {
          text: {
            type: "string",
            description: "The text to reverse",
          },
        },
        required: ["text"],
      },
      async execute(_toolCallId: string, params: Record<string, unknown>) {
        const text = params.text as string;
        const reversed = text.split("").reverse().join("");
        return { content: reversed };
      },
    });

    // ── Hook: before_agent_start ─────────────────────────────────────────
    api.registerHook("before_agent_start", async (_event) => {
      api.logger.debug("Echo plugin: before_agent_start hook fired");
      return {
        systemPrompt: "You have access to an echo tool for testing purposes.",
      };
    });

    // ── Hook: after_tool_call ────────────────────────────────────────────
    api.registerHook("after_tool_call", async (event) => {
      api.logger.debug(
        `Echo plugin: tool "${event.toolName}" completed in ${event.durationMs}ms`
      );
    });

    // ── Command: /echo ──────────────────────────────────────────────────
    api.registerCommand({
      name: "echo",
      description: "Directly echo text (bypasses LLM)",
      async execute(args: string[]) {
        const text = args.join(" ");
        if (!text) return "Usage: /echo <text>";
        let result = `${prefix} ${text}`;
        if (uppercase) result = result.toUpperCase();
        return result;
      },
    });

    // ── Service: echo-heartbeat ─────────────────────────────────────────
    let heartbeatInterval: ReturnType<typeof setInterval> | null = null;

    api.registerService({
      id: "echo-heartbeat",
      start() {
        api.logger.info("Echo heartbeat service started");
        heartbeatInterval = setInterval(() => {
          api.logger.debug("Echo heartbeat: alive");
        }, 60_000);
      },
      stop() {
        if (heartbeatInterval) {
          clearInterval(heartbeatInterval);
          heartbeatInterval = null;
        }
        api.logger.info("Echo heartbeat service stopped");
      },
    });

    api.logger.info("Echo plugin registered successfully");
  },
};

export default echoPlugin;
