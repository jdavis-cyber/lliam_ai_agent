import { timingSafeEqual } from "node:crypto";

/**
 * API Key authenticator using timing-safe comparison.
 *
 * Timing-safe comparison prevents timing attacks where an attacker
 * could measure response time differences to guess the key
 * character-by-character.
 */
export class ApiKeyAuthenticator {
  private keyBuffer: Buffer;

  constructor(apiKey: string) {
    if (!apiKey || apiKey.length < 32) {
      throw new Error(
        "API key must be at least 32 characters. Generate one with: node -e \"console.log(crypto.randomBytes(32).toString('hex'))\""
      );
    }
    this.keyBuffer = Buffer.from(apiKey, "utf-8");
  }

  /**
   * Validate a candidate API key using timing-safe comparison.
   * Returns true if the key matches, false otherwise.
   */
  validate(candidate: string): boolean {
    if (!candidate) return false;

    const candidateBuffer = Buffer.from(candidate, "utf-8");

    // Buffers must be the same length for timingSafeEqual.
    // If they differ, the key is wrong — but we still do a
    // constant-time comparison to avoid leaking length info.
    if (candidateBuffer.length !== this.keyBuffer.length) {
      // Compare against itself to burn the same CPU time,
      // then return false.
      timingSafeEqual(this.keyBuffer, this.keyBuffer);
      return false;
    }

    return timingSafeEqual(candidateBuffer, this.keyBuffer);
  }

  /**
   * Extract API key from an HTTP Authorization header.
   * Supports "Bearer <key>" format.
   */
  static extractFromHeader(header: string | undefined): string | null {
    if (!header) return null;

    if (header.startsWith("Bearer ")) {
      return header.slice(7).trim();
    }

    // Also accept raw key for simplicity
    return header.trim();
  }

  /**
   * Extract API key from a URL query parameter.
   */
  static extractFromQuery(
    query: Record<string, string | string[] | undefined>
  ): string | null {
    const key = query.apiKey ?? query.api_key;
    if (typeof key === "string") return key;
    return null;
  }
}
