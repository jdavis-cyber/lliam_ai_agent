/**
 * Gemini Live Voice Channel Plugin
 *
 * Architecture:
 *   Phone/mic → WebSocket (port 3001) → This plugin → Gemini 3.1 Flash Live API
 *                                                    ← Synthesized audio response
 *
 * Uses gemini-3.1-flash-live-preview (released March 26, 2026).
 * Free during preview via Google AI Studio: https://aistudio.google.com
 *
 * Gemini Live API features used:
 *   - Real-time audio streaming (PCM16, 16kHz)
 *   - Barge-in / interruption support
 *   - Function calling (passes tool calls to Lliam's ToolExecutor)
 *   - Multi-turn voice conversation with session state
 *
 * Security:
 *   - Binds to 127.0.0.1 only (no external exposure without explicit config)
 *   - Phone-number allowlist for caller verification
 *   - Session tokens expire after 30 minutes of inactivity
 *
 * Client setup:
 *   Any WebSocket client that can stream PCM16 audio works.
 *   See README for Twilio Media Streams integration (makes it work with a phone call).
 */

import { WebSocketServer, WebSocket } from "ws";
import type { PluginModule, PluginAPI } from "../../../src/plugin/types.js";
import { handleTwilioMediaStream, generateTwiml } from "./twilio-adapter.js";

// ─── Gemini Live API Types ────────────────────────────────────────────────────

const GEMINI_LIVE_MODEL = "gemini-3.1-flash-live-preview";
const GEMINI_LIVE_ENDPOINT = "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent";

interface GeminiSession {
  ws: WebSocket;                  // Connection to Gemini Live API
  clientWs: WebSocket;            // Connection from phone/mic client
  sessionId: string;
  lastActivity: number;
  turnCount: number;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeSessionId(): string {
  return `gv_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function buildGeminiWsUrl(apiKey: string): string {
  return `${GEMINI_LIVE_ENDPOINT}?key=${apiKey}`;
}

/**
 * Build the Gemini Live session setup message.
 * This configures the model, voice, and system instructions.
 */
function buildSetupMessage(systemPrompt: string): object {
  return {
    setup: {
      model: `models/${GEMINI_LIVE_MODEL}`,
      generation_config: {
        response_modalities: ["AUDIO"],
        speech_config: {
          voice_config: {
            prebuilt_voice_config: {
              voice_name: "Aoede", // Natural-sounding voice
            },
          },
        },
      },
      system_instruction: {
        parts: [{ text: systemPrompt }],
      },
      tools: [
        {
          // Allow Gemini to call back into Lliam's tool system
          function_declarations: [
            {
              name: "lliam_tool",
              description: "Execute a Lliam tool (daily_brief, track_commitment, log_workout, web_search, etc.)",
              parameters: {
                type: "object",
                properties: {
                  tool_name: { type: "string", description: "Name of the Lliam tool to call" },
                  params: { type: "object", description: "Parameters for the tool" },
                },
                required: ["tool_name"],
              },
            },
          ],
        },
      ],
    },
  };
}

// ─── Plugin ───────────────────────────────────────────────────────────────────

const geminiVoicePlugin: PluginModule = {
  id: "executive.gemini-voice",
  name: "Gemini Live Voice Channel",
  version: "1.0.0",
  description: "Real-time voice via Gemini 3.1 Flash Live",

  register(api: PluginAPI) {
    const config = api.pluginConfig as {
      geminiApiKey?: string;
      voicePort?: number;
      twilioPort?: number;
      twilioPublicUrl?: string;
      allowedPhoneNumbers?: string[];
    };

    const apiKey = config.geminiApiKey ?? process.env.GEMINI_API_KEY ?? "";
    const voicePort = config.voicePort ?? 3001;
    const twilioPort = config.twilioPort ?? 3002;
    const twilioPublicUrl = config.twilioPublicUrl ?? process.env.TWILIO_PUBLIC_URL ?? "";
    const allowedNumbers = config.allowedPhoneNumbers ?? [];

    if (!apiKey) {
      api.logger.warn("GEMINI_API_KEY not set — Gemini Voice channel will not start");
      return;
    }

    const activeSessions = new Map<string, GeminiSession>();

    // ── Voice WebSocket Server ────────────────────────────────────────────────

    const SYSTEM_PROMPT = `You are Lliam, Jerome's personal AI executive assistant.
You are speaking directly to Jerome via voice. Keep responses conversational and concise.
When Jerome asks for his brief, commitments, workout log, or web search — call the lliam_tool function.
Speak naturally. If you need to think, say "give me a moment". Do not read out JSON or raw data — summarize it.`;

    let wss: WebSocketServer | null = null;

    // ── Service: voice-server ─────────────────────────────────────────────────
    api.registerService({
      id: "gemini-voice-server",

      start() {
        wss = new WebSocketServer({
          port: voicePort,
          host: "127.0.0.1", // localhost only — never expose externally
        });

        api.logger.info(`Gemini Voice server listening on ws://127.0.0.1:${voicePort}`);

        wss.on("connection", (clientWs, req) => {
          // Caller ID check (for Twilio integration)
          const callerId = req.headers["x-twilio-caller-id"] as string | undefined;
          if (allowedNumbers.length > 0 && callerId && !allowedNumbers.includes(callerId)) {
            api.logger.warn(`Blocked caller: ${callerId}`);
            clientWs.close(4003, "Caller not allowed");
            return;
          }

          const sessionId = makeSessionId();
          api.logger.info(`Voice session started: ${sessionId}`);

          // Open upstream connection to Gemini Live
          const geminiWs = new WebSocket(buildGeminiWsUrl(apiKey));
          let setupSent = false;

          geminiWs.on("open", () => {
            // Send setup immediately
            geminiWs.send(JSON.stringify(buildSetupMessage(SYSTEM_PROMPT)));
            setupSent = true;
            api.logger.debug(`Gemini WS open for session ${sessionId}`);
          });

          // Track session
          const session: GeminiSession = {
            ws: geminiWs,
            clientWs,
            sessionId,
            lastActivity: Date.now(),
            turnCount: 0,
          };
          activeSessions.set(sessionId, session);

          // ── Client → Gemini (audio relay) ──────────────────────────────────
          clientWs.on("message", (data) => {
            session.lastActivity = Date.now();

            if (!setupSent || geminiWs.readyState !== WebSocket.OPEN) return;

            if (Buffer.isBuffer(data)) {
              // Raw PCM16 audio — wrap in Gemini realtime_input format
              geminiWs.send(JSON.stringify({
                realtime_input: {
                  media_chunks: [{
                    data: data.toString("base64"),
                    mime_type: "audio/pcm;rate=16000",
                  }],
                },
              }));
            } else {
              // Text/control messages from client
              try {
                const msg = JSON.parse(data.toString());
                if (msg.type === "text") {
                  geminiWs.send(JSON.stringify({
                    client_content: {
                      turns: [{ role: "user", parts: [{ text: msg.text }] }],
                      turn_complete: true,
                    },
                  }));
                }
              } catch { /* ignore malformed */ }
            }
          });

          // ── Gemini → Client (audio + function calls) ───────────────────────
          geminiWs.on("message", async (raw) => {
            session.lastActivity = Date.now();
            try {
              const msg = JSON.parse(raw.toString());

              // Audio response — relay directly to client
              if (msg.server_content?.model_turn?.parts) {
                for (const part of msg.server_content.model_turn.parts) {
                  if (part.inline_data?.mime_type?.startsWith("audio/")) {
                    const audioBuf = Buffer.from(part.inline_data.data, "base64");
                    if (clientWs.readyState === WebSocket.OPEN) {
                      clientWs.send(audioBuf);
                    }
                  }
                  if (part.text && clientWs.readyState === WebSocket.OPEN) {
                    clientWs.send(JSON.stringify({ type: "transcript", text: part.text }));
                  }
                }
              }

              // Function call — execute via Lliam tool system
              if (msg.tool_call?.function_calls) {
                for (const fc of msg.tool_call.function_calls) {
                  if (fc.name === "lliam_tool") {
                    const toolName = fc.args?.tool_name as string;
                    const toolParams = fc.args?.params as Record<string, unknown> ?? {};

                    api.logger.info(`Voice function call: ${toolName}`);
                    let resultText = "";

                    try {
                      // Use the tool executor service if registered
                      const toolExecutor = api.getService("tool-executor");
                      if (toolExecutor && typeof (toolExecutor as {execute?: unknown}).execute === "function") {
                        const result = await (toolExecutor as { execute: (name: string, id: string, params: Record<string, unknown>) => Promise<{content: string}> }).execute(toolName, fc.id, toolParams);
                        resultText = result.content;
                      } else {
                        resultText = `Tool ${toolName} not available via voice`;
                      }
                    } catch (err) {
                      resultText = `Error: ${err instanceof Error ? err.message : String(err)}`;
                    }

                    // Send function result back to Gemini
                    if (geminiWs.readyState === WebSocket.OPEN) {
                      geminiWs.send(JSON.stringify({
                        tool_response: {
                          function_responses: [{
                            id: fc.id,
                            name: fc.name,
                            response: { result: resultText },
                          }],
                        },
                      }));
                    }
                  }
                }
              }
            } catch (err) {
              api.logger.error(`Gemini message parse error: ${err}`);
            }
          });

          // ── Cleanup ────────────────────────────────────────────────────────
          const cleanup = () => {
            activeSessions.delete(sessionId);
            if (geminiWs.readyState === WebSocket.OPEN) geminiWs.close();
            api.logger.info(`Voice session ended: ${sessionId} (${session.turnCount} turns)`);
          };

          clientWs.on("close", cleanup);
          clientWs.on("error", cleanup);
          geminiWs.on("close", () => {
            if (clientWs.readyState === WebSocket.OPEN) clientWs.close();
            activeSessions.delete(sessionId);
          });
          geminiWs.on("error", (err) => {
            api.logger.error(`Gemini WS error: ${err.message}`);
            cleanup();
          });
        });

        wss.on("error", (err) => {
          api.logger.error(`Voice server error: ${err.message}`);
        });

        // Session timeout: close inactive sessions after 30 min
        setInterval(() => {
          const now = Date.now();
          for (const [id, session] of activeSessions.entries()) {
            if (now - session.lastActivity > 30 * 60 * 1000) {
              api.logger.info(`Voice session ${id} timed out`);
              session.clientWs.close(4000, "Session timeout");
              session.ws.close();
              activeSessions.delete(id);
            }
          }
        }, 60_000);
      },

      stop() {
        // Close all active sessions
        for (const session of activeSessions.values()) {
          session.clientWs.close(1001, "Server shutting down");
          session.ws.close();
        }
        activeSessions.clear();

        if (wss) {
          wss.close();
          wss = null;
        }
        api.logger.info("Gemini Voice server stopped");
      },
    });

    // ── Service: twilio-media-bridge ────────────────────────────────────────────
    let twilioWss: WebSocketServer | null = null;
    let twilioHttpServer: import("node:http").Server | null = null;

    api.registerService({
      id: "twilio-media-bridge",

      async start() {
        if (!twilioPublicUrl) {
          api.logger.info(
            "Twilio adapter: TWILIO_PUBLIC_URL not set — Twilio bridge disabled. " +
            "Set this to your ngrok/tunnel URL to enable phone call integration."
          );
          return;
        }

        const http = await import("node:http");

        // Create HTTP server for TwiML webhook + WS upgrade
        twilioHttpServer = http.createServer((req, res) => {
          if (req.method === "POST" && req.url === "/twilio/voice") {
            const streamUrl = twilioPublicUrl.replace(/^https?/, "wss") + "/twilio/media";
            const twiml = generateTwiml(streamUrl);
            res.writeHead(200, { "Content-Type": "text/xml" });
            res.end(twiml);
            api.logger.info("Twilio TwiML served — connecting call to media stream");
          } else {
            res.writeHead(404);
            res.end("Not found");
          }
        });

        // WebSocket server for Twilio Media Streams
        twilioWss = new WebSocketServer({ server: twilioHttpServer, path: "/twilio/media" });

        twilioWss.on("connection", (ws) => {
          api.logger.info("Twilio Media Stream connected");
          handleTwilioMediaStream(ws, {
            geminiVoicePort: voicePort,
            publicStreamUrl: twilioPublicUrl,
            logger: api.logger,
          });
        });

        twilioHttpServer.listen(twilioPort, "0.0.0.0", () => {
          api.logger.info(
            `Twilio adapter listening on port ${twilioPort} ` +
            `(TwiML: POST /twilio/voice, Media: WS /twilio/media)`
          );
        });
      },

      stop() {
        if (twilioWss) {
          twilioWss.close();
          twilioWss = null;
        }
        if (twilioHttpServer) {
          twilioHttpServer.close();
          twilioHttpServer = null;
        }
        api.logger.info("Twilio adapter stopped");
      },
    });

    // ── Tool: voice_status ────────────────────────────────────────────────────
    api.registerTool({
      name: "voice_status",
      description: "Check the status of the Gemini Live voice channel — active sessions, port, model, Twilio adapter.",
      parameters: { type: "object" as const, properties: {}, required: [] },
      async execute() {
        return {
          content: JSON.stringify({
            model: GEMINI_LIVE_MODEL,
            voice_port: voicePort,
            bound_to: "127.0.0.1 (localhost only)",
            active_sessions: activeSessions.size,
            api_key_configured: !!apiKey,
            allowed_numbers: allowedNumbers.length > 0 ? allowedNumbers : "any",
            connect_url: `ws://127.0.0.1:${voicePort}`,
            twilio: {
              enabled: !!twilioPublicUrl,
              port: twilioPort,
              public_url: twilioPublicUrl || "(not configured)",
              twiml_webhook: twilioPublicUrl ? `${twilioPublicUrl}/twilio/voice` : "(not configured)",
              media_stream: twilioPublicUrl ? `${twilioPublicUrl.replace(/^https?/, "wss")}/twilio/media` : "(not configured)",
            },
          }, null, 2),
        };
      },
    });

    api.logger.info(`Gemini Live Voice channel registered (port ${voicePort}, model: ${GEMINI_LIVE_MODEL})`);
  },
};

export default geminiVoicePlugin;
