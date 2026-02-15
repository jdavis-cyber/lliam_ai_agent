import { describe, it, expect } from "vitest";
import { ApiKeyAuthenticator } from "../gateway/auth.js";

const VALID_KEY = "a".repeat(32); // Minimum 32 chars

describe("ApiKeyAuthenticator", () => {
  describe("constructor", () => {
    it("should accept keys of 32+ characters", () => {
      expect(() => new ApiKeyAuthenticator(VALID_KEY)).not.toThrow();
    });

    it("should reject keys shorter than 32 characters", () => {
      expect(() => new ApiKeyAuthenticator("short-key")).toThrow(
        "at least 32 characters"
      );
    });

    it("should reject empty string", () => {
      expect(() => new ApiKeyAuthenticator("")).toThrow(
        "at least 32 characters"
      );
    });
  });

  describe("validate", () => {
    it("should return true for matching key", () => {
      const auth = new ApiKeyAuthenticator(VALID_KEY);
      expect(auth.validate(VALID_KEY)).toBe(true);
    });

    it("should return false for wrong key", () => {
      const auth = new ApiKeyAuthenticator(VALID_KEY);
      expect(auth.validate("b".repeat(32))).toBe(false);
    });

    it("should return false for different length key", () => {
      const auth = new ApiKeyAuthenticator(VALID_KEY);
      expect(auth.validate("short")).toBe(false);
    });

    it("should return false for empty string", () => {
      const auth = new ApiKeyAuthenticator(VALID_KEY);
      expect(auth.validate("")).toBe(false);
    });

    it("should handle long keys correctly", () => {
      const longKey = "x".repeat(256);
      const auth = new ApiKeyAuthenticator(longKey);
      expect(auth.validate(longKey)).toBe(true);
      expect(auth.validate(longKey + "y")).toBe(false);
    });
  });

  describe("extractFromHeader", () => {
    it("should extract key from Bearer token", () => {
      const key = ApiKeyAuthenticator.extractFromHeader("Bearer my-api-key");
      expect(key).toBe("my-api-key");
    });

    it("should accept raw key without Bearer prefix", () => {
      const key = ApiKeyAuthenticator.extractFromHeader("my-api-key");
      expect(key).toBe("my-api-key");
    });

    it("should return null for undefined header", () => {
      const key = ApiKeyAuthenticator.extractFromHeader(undefined);
      expect(key).toBeNull();
    });

    it("should trim whitespace", () => {
      const key = ApiKeyAuthenticator.extractFromHeader("Bearer   my-key  ");
      expect(key).toBe("my-key");
    });
  });

  describe("extractFromQuery", () => {
    it("should extract from apiKey param", () => {
      const key = ApiKeyAuthenticator.extractFromQuery({ apiKey: "my-key" });
      expect(key).toBe("my-key");
    });

    it("should extract from api_key param", () => {
      const key = ApiKeyAuthenticator.extractFromQuery({ api_key: "my-key" });
      expect(key).toBe("my-key");
    });

    it("should return null when missing", () => {
      const key = ApiKeyAuthenticator.extractFromQuery({});
      expect(key).toBeNull();
    });

    it("should return null for array values", () => {
      const key = ApiKeyAuthenticator.extractFromQuery({
        apiKey: ["a", "b"],
      });
      expect(key).toBeNull();
    });
  });
});
