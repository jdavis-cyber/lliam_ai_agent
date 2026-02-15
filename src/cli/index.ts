#!/usr/bin/env node

import { createInterface } from "node:readline";
import { program } from "commander";
import dotenv from "dotenv";
import { Agent } from "../core/agent.js";
import { AgentConfigSchema } from "../types/index.js";
import { loadConfig } from "../config/schema.js";
import { startGatewayServer, stopGatewayServer } from "../gateway/server.js";
import type { GatewayServerState } from "../gateway/server.js";

// Load environment variables from .env file
dotenv.config();

const VERSION = "0.1.0";
const BANNER = `
  ╔═══════════════════════════════════════╗
  ║           L L I A M   v${VERSION}           ║
  ║     Personal AI Assistant Platform    ║
  ╚═══════════════════════════════════════╝
`;

// ─── Chat Command ───────────────────────────────────────────────────────────

/**
 * Start an interactive chat REPL session (direct, no server).
 */
async function startChat(options: {
  model?: string;
  temperature?: string;
  maxTokens?: string;
}): Promise<void> {
  console.log(BANNER);

  const config = AgentConfigSchema.parse({
    model: options.model,
    temperature: options.temperature
      ? parseFloat(options.temperature)
      : undefined,
    maxTokens: options.maxTokens ? parseInt(options.maxTokens, 10) : undefined,
  });

  let agent: Agent;
  try {
    agent = new Agent(config);
  } catch (error) {
    if (error instanceof Error) {
      console.error(`\n  Error: ${error.message}\n`);
    }
    process.exit(1);
  }

  console.log(`  Model: ${config.model}`);
  console.log(`  Temperature: ${config.temperature}`);
  console.log(`  Max tokens: ${config.maxTokens}`);
  console.log(`\n  Type your message and press Enter. Commands:`);
  console.log(`    /new     — Start a new conversation`);
  console.log(`    /history — Show conversation history`);
  console.log(`    /exit    — Quit Lliam\n`);

  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: "  You > ",
  });

  rl.prompt();

  rl.on("line", async (line: string) => {
    const input = line.trim();

    if (!input) {
      rl.prompt();
      return;
    }

    if (input.startsWith("/")) {
      await handleCommand(input, agent, rl);
      return;
    }

    try {
      process.stdout.write("\n  Lliam > ");

      const response = await agent.executeMessage(input, (chunk: string) => {
        process.stdout.write(chunk);
      });

      const { inputTokens, outputTokens } = response.tokenUsage;
      console.log(
        `\n\n  [tokens: ${inputTokens} in / ${outputTokens} out | ${response.model}]\n`
      );
    } catch (error) {
      if (error instanceof Error) {
        console.error(`\n  Error: ${error.message}\n`);
      } else {
        console.error(`\n  An unexpected error occurred.\n`);
      }
    }

    rl.prompt();
  });

  rl.on("close", () => {
    console.log("\n  Goodbye.\n");
    process.exit(0);
  });

  rl.on("SIGINT", () => {
    rl.close();
  });
}

/**
 * Handle slash commands within the REPL.
 */
async function handleCommand(
  input: string,
  agent: Agent,
  rl: ReturnType<typeof createInterface>
): Promise<void> {
  const cmd = input.toLowerCase().split(" ")[0];

  switch (cmd) {
    case "/new":
      agent.clearHistory();
      console.log("\n  Conversation cleared. Starting fresh.\n");
      break;

    case "/history": {
      const history = agent.getHistory();
      if (history.length === 0) {
        console.log("\n  No conversation history yet.\n");
      } else {
        console.log(`\n  Conversation history (${history.length} messages):`);
        for (const msg of history) {
          const role = msg.role === "user" ? "You" : "Lliam";
          const preview =
            msg.content.length > 80
              ? msg.content.substring(0, 80) + "..."
              : msg.content;
          const time = new Date(msg.timestamp).toLocaleTimeString();
          console.log(`    [${time}] ${role}: ${preview}`);
        }
        console.log();
      }
      break;
    }

    case "/config": {
      const config = agent.getConfig();
      console.log("\n  Current configuration:");
      console.log(`    Model:       ${config.model}`);
      console.log(`    Temperature: ${config.temperature}`);
      console.log(`    Max tokens:  ${config.maxTokens}`);
      console.log(`    Max retries: ${config.maxRetries}`);
      console.log();
      break;
    }

    case "/exit":
    case "/quit":
      rl.close();
      return;

    default:
      console.log(
        `\n  Unknown command: ${cmd}. Available: /new, /history, /config, /exit\n`
      );
  }

  rl.prompt();
}

// ─── Start Command (Gateway Server) ─────────────────────────────────────────

/**
 * Start the Lliam gateway server in the foreground.
 */
async function startServer(options: {
  port?: string;
  apiKey?: string;
}): Promise<void> {
  console.log(BANNER);
  console.log("  Starting gateway server...\n");

  const overrides: Record<string, unknown> = {};
  const gatewayOverrides: Record<string, unknown> = {};
  if (options.port) gatewayOverrides.port = parseInt(options.port, 10);
  if (options.apiKey) gatewayOverrides.apiKey = options.apiKey;
  else if (process.env.LLIAM_API_KEY) gatewayOverrides.apiKey = process.env.LLIAM_API_KEY;
  if (Object.keys(gatewayOverrides).length > 0) overrides.gateway = gatewayOverrides;

  const config = loadConfig(overrides as Partial<import("../config/schema.js").AppConfig>);

  let serverState: GatewayServerState;

  try {
    serverState = await startGatewayServer(config);
  } catch (error) {
    if (error instanceof Error) {
      console.error(`\n  Failed to start gateway: ${error.message}\n`);
    }
    process.exit(1);
  }

  // Graceful shutdown handlers
  const shutdown = async (signal: string) => {
    console.log(`\n  Received ${signal}. Shutting down...`);
    await stopGatewayServer(serverState);
    process.exit(0);
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  console.log("\n  Press Ctrl+C to stop.\n");
}

// ─── Status Command ─────────────────────────────────────────────────────────

async function showStatus(): Promise<void> {
  const config = loadConfig();
  const { host, port } = config.gateway;
  const url = `http://${host}:${port}/api/health`;

  try {
    const response = await fetch(url);
    const data = await response.json();
    console.log(BANNER);
    console.log("  Gateway status:");
    console.log(`    URL:       http://${host}:${port}`);
    console.log(`    Status:    ${(data as { status?: string }).status ?? "unknown"}`);
    console.log(`    Timestamp: ${new Date((data as { timestamp?: number }).timestamp ?? 0).toLocaleString()}`);
    console.log();
  } catch {
    console.log(BANNER);
    console.log("  Gateway status: NOT RUNNING");
    console.log(`    Expected at: http://${host}:${port}`);
    console.log();
  }
}

// ─── CLI Program Definition ─────────────────────────────────────────────────

program
  .name("lliam")
  .description("Lliam — Personal AI Assistant Platform")
  .version(VERSION);

program
  .command("chat")
  .description("Start an interactive chat session (direct, no server)")
  .option("-m, --model <model>", "Claude model to use")
  .option("-t, --temperature <temp>", "Response temperature (0-1)")
  .option("--max-tokens <tokens>", "Maximum response tokens")
  .action(startChat);

program
  .command("start")
  .description("Start the Lliam gateway server")
  .option("-p, --port <port>", "Port to listen on (default: 3000)")
  .option("-k, --api-key <key>", "API key for authentication")
  .action(startServer);

program
  .command("status")
  .description("Check if the gateway server is running")
  .action(showStatus);

// Default to chat if no command is specified
program.action(() => {
  program.commands
    .find((cmd) => cmd.name() === "chat")
    ?.parseAsync(process.argv);
});

program.parse();
