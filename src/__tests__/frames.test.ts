import { describe, it, expect } from "vitest";
import {
  parseRequestFrame,
  successResponse,
  errorResponse,
} from "../gateway/frames.js";

describe("Frame parsing", () => {
  describe("parseRequestFrame", () => {
    it("should parse a valid agent.message frame", () => {
      const raw = JSON.stringify({
        type: "request",
        requestId: "req-1",
        method: "agent.message",
        params: { message: "Hello", sessionId: "s-1" },
      });
      const frame = parseRequestFrame(raw);
      expect(frame).not.toBeNull();
      expect(frame!.method).toBe("agent.message");
      expect(frame!.requestId).toBe("req-1");
    });

    it("should parse sessions.list frame", () => {
      const raw = JSON.stringify({
        type: "request",
        requestId: "req-2",
        method: "sessions.list",
      });
      const frame = parseRequestFrame(raw);
      expect(frame).not.toBeNull();
      expect(frame!.method).toBe("sessions.list");
    });

    it("should parse ping frame", () => {
      const raw = JSON.stringify({
        type: "request",
        requestId: "req-3",
        method: "ping",
      });
      const frame = parseRequestFrame(raw);
      expect(frame).not.toBeNull();
      expect(frame!.method).toBe("ping");
    });

    it("should return null for invalid JSON", () => {
      expect(parseRequestFrame("not json")).toBeNull();
    });

    it("should return null for missing type field", () => {
      const raw = JSON.stringify({ requestId: "req", method: "ping" });
      expect(parseRequestFrame(raw)).toBeNull();
    });

    it("should return null for wrong type value", () => {
      const raw = JSON.stringify({
        type: "response",
        requestId: "req",
        method: "ping",
      });
      expect(parseRequestFrame(raw)).toBeNull();
    });

    it("should return null for unknown method", () => {
      const raw = JSON.stringify({
        type: "request",
        requestId: "req",
        method: "unknown.method",
      });
      expect(parseRequestFrame(raw)).toBeNull();
    });

    it("should return null for empty requestId", () => {
      const raw = JSON.stringify({
        type: "request",
        requestId: "",
        method: "ping",
      });
      expect(parseRequestFrame(raw)).toBeNull();
    });
  });

  describe("successResponse", () => {
    it("should create a success frame", () => {
      const frame = successResponse("req-1", { data: "test" });
      expect(frame.type).toBe("response");
      expect(frame.requestId).toBe("req-1");
      expect(frame.ok).toBe(true);
      expect(frame.payload).toEqual({ data: "test" });
      expect(frame.error).toBeUndefined();
    });

    it("should work without payload", () => {
      const frame = successResponse("req-1");
      expect(frame.ok).toBe(true);
      expect(frame.payload).toBeUndefined();
    });
  });

  describe("errorResponse", () => {
    it("should create an error frame", () => {
      const frame = errorResponse("req-1", "Something went wrong");
      expect(frame.type).toBe("response");
      expect(frame.requestId).toBe("req-1");
      expect(frame.ok).toBe(false);
      expect(frame.error).toBe("Something went wrong");
    });
  });
});
