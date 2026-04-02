/**
 * KeyManager — AES-256-GCM encryption at rest for session and database files.
 *
 * Key derivation:
 *   - macOS Keychain (via keytar) is the primary secret store.
 *   - On first boot, a 32-byte random machine secret is generated and stored
 *     in the Keychain under service "lliam" / account "encryption-secret".
 *   - The encryption key is derived from the secret via scrypt with a fixed
 *     per-installation salt (stored alongside the secret in Keychain), so the
 *     key is reproducible across process restarts but bound to the machine.
 *   - The derived key is held only in memory — never written to disk.
 *
 * Encryption format (returned as Buffer):
 *   [ version:1 | iv:12 | authTag:16 | ciphertext:N ]
 *
 * Key rotation:
 *   - Call rotateKey() to generate a new machine secret. All encrypted files
 *     must be re-encrypted by the caller (runner-factory rotate-key flow).
 *
 * R-01 / R-02 compliance:
 *   - NIST SP 800-53 SC-28 (Protection of Information at Rest)
 *   - ISO 42001 Annex A 8.4 (Data governance)
 */

import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";
import keytar from "keytar";

// ─── Constants ───────────────────────────────────────────────────────────────

const KEYCHAIN_SERVICE = "lliam";
const KEYCHAIN_ACCOUNT_SECRET = "encryption-secret";
const KEYCHAIN_ACCOUNT_SALT = "encryption-salt";

const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_LENGTH = 32; // 256 bits for AES-256
const IV_LENGTH = 12;  // 96 bits — recommended for GCM
const TAG_LENGTH = 16; // 128 bits — GCM auth tag
const FORMAT_VERSION = 0x01;

// ─── KeyManager ──────────────────────────────────────────────────────────────

export class KeyManager {
  private derivedKey: Buffer | null = null;

  /**
   * Initialize the key manager. Loads or creates the machine secret in Keychain,
   * then derives the AES-256 key into memory.
   *
   * Must be called once at startup before any encrypt/decrypt calls.
   */
  async init(): Promise<void> {
    const { secret, salt } = await this.getOrCreateSecret();
    this.derivedKey = scryptSync(secret, salt, KEY_LENGTH, {
      N: SCRYPT_N,
      r: SCRYPT_R,
      p: SCRYPT_P,
    });
  }

  /**
   * Encrypt a Buffer using AES-256-GCM.
   * Returns a new Buffer: [ version:1 | iv:12 | authTag:16 | ciphertext:N ]
   */
  encrypt(plaintext: Buffer): Buffer {
    const key = this.requireKey();
    const iv = randomBytes(IV_LENGTH);

    const cipher = createCipheriv("aes-256-gcm", key, iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const authTag = cipher.getAuthTag();

    return Buffer.concat([
      Buffer.from([FORMAT_VERSION]),
      iv,
      authTag,
      ciphertext,
    ]);
  }

  /**
   * Decrypt a Buffer previously encrypted by encrypt().
   * Throws if the auth tag verification fails (tamper detection).
   */
  decrypt(encrypted: Buffer): Buffer {
    const key = this.requireKey();

    const version = encrypted[0];
    if (version !== FORMAT_VERSION) {
      throw new Error(`Unsupported encryption format version: ${version}`);
    }

    const iv = encrypted.subarray(1, 1 + IV_LENGTH);
    const authTag = encrypted.subarray(1 + IV_LENGTH, 1 + IV_LENGTH + TAG_LENGTH);
    const ciphertext = encrypted.subarray(1 + IV_LENGTH + TAG_LENGTH);

    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(authTag);

    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  }

  /**
   * Check whether a buffer looks like it was encrypted by this key manager.
   * Used to auto-detect legacy plaintext files for migration.
   */
  isEncrypted(buffer: Buffer): boolean {
    // Encrypted buffers always start with FORMAT_VERSION byte
    // and are at least version(1) + iv(12) + tag(16) + 1 byte of ciphertext
    if (buffer.length < 1 + IV_LENGTH + TAG_LENGTH + 1) return false;
    return buffer[0] === FORMAT_VERSION;
  }

  /**
   * Rotate the machine secret. Generates a new secret and salt in Keychain.
   * The caller is responsible for re-encrypting all existing encrypted files
   * using the old key before calling this, or accepting that they will be lost.
   *
   * After rotation, init() must be called again to load the new derived key.
   */
  async rotateKey(): Promise<void> {
    const newSecret = randomBytes(32).toString("hex");
    const newSalt = randomBytes(16).toString("hex");

    await keytar.setPassword(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT_SECRET, newSecret);
    await keytar.setPassword(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT_SALT, newSalt);

    // Clear in-memory key — caller must re-init
    this.derivedKey = null;
  }

  /**
   * Whether the key manager has been initialized.
   */
  isReady(): boolean {
    return this.derivedKey !== null;
  }

  // ─── Internals ──────────────────────────────────────────────────────────

  private requireKey(): Buffer {
    if (!this.derivedKey) {
      throw new Error("KeyManager not initialized. Call init() before encrypt/decrypt.");
    }
    return this.derivedKey;
  }

  private async getOrCreateSecret(): Promise<{ secret: string; salt: string }> {
    let secret = await keytar.getPassword(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT_SECRET);
    let salt = await keytar.getPassword(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT_SALT);

    if (!secret || !salt) {
      // First boot — generate and store
      secret = randomBytes(32).toString("hex");
      salt = randomBytes(16).toString("hex");

      await keytar.setPassword(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT_SECRET, secret);
      await keytar.setPassword(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT_SALT, salt);

      console.log("  KeyManager: Generated new machine encryption secret (stored in Keychain).");
    }

    return { secret, salt };
  }
}

// ─── Singleton ────────────────────────────────────────────────────────────────

// Single shared instance — initialized once in runner-factory, used everywhere.
export const keyManager = new KeyManager();
