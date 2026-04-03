/**
 * Twilio Media Streams Adapter
 *
 * Bridges Twilio Media Streams (mulaw 8kHz, JSON-framed WebSocket)
 * to the Gemini Live Voice plugin (PCM16 16kHz, raw binary WebSocket).
 *
 * Architecture:
 *   Phone call → Twilio → Media Stream WS → This adapter → Gemini Voice WS (localhost)
 *                                         ← Audio relay ← Gemini Voice WS (localhost)
 *
 * Audio transcoding:
 *   - Inbound: mulaw 8kHz → PCM16 16kHz (expand + upsample)
 *   - Outbound: PCM16 16kHz → mulaw 8kHz (downsample + compress)
 *
 * Endpoints:
 *   POST /twilio/voice  — TwiML webhook (returns <Connect><Stream>)
 *   WS   /twilio/media  — Media Streams WebSocket endpoint
 *
 * Requires: express route registration on the main gateway.
 */

import { WebSocket } from "ws";
import type { PluginLogger } from "../../../src/plugin/types.js";

// ─── mulaw codec ─────────────────────────────────────────────────────────────

const MULAW_BIAS = 33;
const MULAW_CLIP = 32635;
const MULAW_EXP_TABLE = new Int16Array([
  0, 132, 396, 924, 1980, 4092, 8316, 16764,
]);

/** Encode a 16-bit linear PCM sample to 8-bit mulaw */
function linearToMulaw(sample: number): number {
  let sign = 0;
  if (sample < 0) {
    sign = 0x80;
    sample = -sample;
  }
  if (sample > MULAW_CLIP) sample = MULAW_CLIP;
  sample += MULAW_BIAS;

  let exponent = 7;
  for (let expMask = 0x4000; (sample & expMask) === 0 && exponent > 0; exponent--, expMask >>= 1) {
    // find segment
  }

  const mantissa = (sample >> (exponent + 3)) & 0x0f;
  const mulawByte = ~(sign | (exponent << 4) | mantissa) & 0xff;
  return mulawByte;
}

/** Decode 8-bit mulaw to 16-bit linear PCM */
function mulawToLinear(mulawByte: number): number {
  mulawByte = ~mulawByte & 0xff;
  const sign = mulawByte & 0x80;
  const exponent = (mulawByte >> 4) & 0x07;
  const mantissa = mulawByte & 0x0f;
  let sample = MULAW_EXP_TABLE[exponent] + (mantissa << (exponent + 3));
  if (sign !== 0) sample = -sample;
  return sample;
}

// ─── Resampling ──────────────────────────────────────────────────────────────

/** Upsample PCM16 from 8kHz to 16kHz using linear interpolation */
function upsample8to16(input: Int16Array): Int16Array {
  const output = new Int16Array(input.length * 2);
  for (let i = 0; i < input.length; i++) {
    output[i * 2] = input[i];
    if (i < input.length - 1) {
      output[i * 2 + 1] = Math.round((input[i] + input[i + 1]) / 2);
    } else {
      output[i * 2 + 1] = input[i];
    }
  }
  return output;
}

/** Downsample PCM16 from 16kHz to 8kHz (take every other sample) */
function downsample16to8(input: Int16Array): Int16Array {
  const output = new Int16Array(Math.ceil(input.length / 2));
  for (let i = 0; i < output.length; i++) {
    output[i] = input[i * 2];
  }
  return output;
}

// ─── Twilio → Gemini transcoding ─────────────────────────────────────────────

/** Convert Twilio mulaw base64 (8kHz) to PCM16 buffer (16kHz) for Gemini */
export function twilioToGemini(mulawBase64: string): Buffer {
  const mulawBytes = Buffer.from(mulawBase64, "base64");

  // Decode mulaw → PCM16 at 8kHz
  const pcm8k = new Int16Array(mulawBytes.length);
  for (let i = 0; i < mulawBytes.length; i++) {
    pcm8k[i] = mulawToLinear(mulawBytes[i]);
  }

  // Upsample 8kHz → 16kHz
  const pcm16k = upsample8to16(pcm8k);

  // Return as raw PCM16 LE buffer
  return Buffer.from(pcm16k.buffer);
}

/** Convert PCM16 buffer (16kHz) from Gemini to mulaw base64 (8kHz) for Twilio */
export function geminiToTwilio(pcm16Buffer: Buffer): string {
  // Read as Int16 LE
  const pcm16k = new Int16Array(
    pcm16Buffer.buffer,
    pcm16Buffer.byteOffset,
    pcm16Buffer.byteLength / 2
  );

  // Downsample 16kHz → 8kHz
  const pcm8k = downsample16to8(pcm16k);

  // Encode PCM16 → mulaw
  const mulawBytes = Buffer.alloc(pcm8k.length);
  for (let i = 0; i < pcm8k.length; i++) {
    mulawBytes[i] = linearToMulaw(pcm8k[i]);
  }

  return mulawBytes.toString("base64");
}

// ─── TwiML Response ──────────────────────────────────────────────────────────

/**
 * Generate TwiML response that connects the call to a Media Stream.
 * The stream URL must be the publicly accessible WebSocket endpoint.
 */
export function generateTwiml(streamUrl: string): string {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    "<Response>",
    '  <Connect>',
    `    <Stream url="${streamUrl}" />`,
    '  </Connect>',
    "</Response>",
  ].join("\n");
}

// ─── Twilio Media Stream Session ─────────────────────────────────────────────

export interface TwilioAdapterConfig {
  /** Port where the Gemini voice WS server is running */
  geminiVoicePort: number;
  /** Public URL for the media stream WS (e.g. wss://yourdomain.com/twilio/media) */
  publicStreamUrl: string;
  /** Logger instance */
  logger: PluginLogger;
}

/**
 * Handle a single Twilio Media Streams WebSocket connection.
 *
 * Creates a proxy WebSocket to the local Gemini Voice server,
 * transcodes audio between mulaw/8kHz and PCM16/16kHz.
 */
export function handleTwilioMediaStream(
  twilioWs: WebSocket,
  config: TwilioAdapterConfig
): void {
  const { geminiVoicePort, logger } = config;
  let streamSid = "";
  let callSid = "";
  let geminiWs: WebSocket | null = null;

  twilioWs.on("message", (data) => {
    try {
      const msg = JSON.parse(data.toString());

      switch (msg.event) {
        case "connected":
          logger.info(`Twilio stream connected: protocol=${msg.protocol}`);
          break;

        case "start":
          streamSid = msg.start?.streamSid ?? "";
          callSid = msg.start?.callSid ?? "";
          logger.info(`Twilio stream started: callSid=${callSid}, streamSid=${streamSid}`);

          // Connect to local Gemini voice server
          geminiWs = new WebSocket(`ws://127.0.0.1:${geminiVoicePort}`, {
            headers: {
              "x-twilio-caller-id": msg.start?.customParameters?.callerNumber ?? "",
              "x-twilio-call-sid": callSid,
            },
          });

          geminiWs.on("open", () => {
            logger.debug(`Gemini voice proxy open for callSid=${callSid}`);
          });

          // Gemini → Twilio: transcode PCM16 16kHz → mulaw 8kHz
          geminiWs.on("message", (geminiData) => {
            if (twilioWs.readyState !== WebSocket.OPEN) return;

            if (Buffer.isBuffer(geminiData)) {
              // Audio data — transcode and send as Twilio media event
              const mulawBase64 = geminiToTwilio(geminiData);
              twilioWs.send(JSON.stringify({
                event: "media",
                streamSid,
                media: {
                  payload: mulawBase64,
                },
              }));
            } else {
              // Text/transcript from Gemini — could forward as mark event
              try {
                const geminiMsg = JSON.parse(geminiData.toString());
                if (geminiMsg.type === "transcript") {
                  // Send a mark event so Twilio knows about speech segments
                  twilioWs.send(JSON.stringify({
                    event: "mark",
                    streamSid,
                    mark: {
                      name: `transcript_${Date.now()}`,
                    },
                  }));
                }
              } catch {
                // Ignore unparseable
              }
            }
          });

          geminiWs.on("error", (err) => {
            logger.error(`Gemini proxy error for callSid=${callSid}: ${err.message}`);
          });

          geminiWs.on("close", () => {
            logger.debug(`Gemini proxy closed for callSid=${callSid}`);
          });
          break;

        case "media":
          // Twilio → Gemini: transcode mulaw 8kHz → PCM16 16kHz
          if (geminiWs && geminiWs.readyState === WebSocket.OPEN && msg.media?.payload) {
            const pcmBuffer = twilioToGemini(msg.media.payload);
            geminiWs.send(pcmBuffer);
          }
          break;

        case "stop":
          logger.info(`Twilio stream stopped: callSid=${callSid}`);
          if (geminiWs && geminiWs.readyState === WebSocket.OPEN) {
            geminiWs.close();
          }
          break;

        default:
          // dtmf, mark, etc. — ignore
          break;
      }
    } catch (err) {
      logger.error(`Twilio message parse error: ${err instanceof Error ? err.message : String(err)}`);
    }
  });

  twilioWs.on("close", () => {
    if (geminiWs && geminiWs.readyState === WebSocket.OPEN) {
      geminiWs.close();
    }
    logger.info(`Twilio WS closed: callSid=${callSid}`);
  });

  twilioWs.on("error", (err) => {
    logger.error(`Twilio WS error: ${err.message}`);
    if (geminiWs && geminiWs.readyState === WebSocket.OPEN) {
      geminiWs.close();
    }
  });
}
