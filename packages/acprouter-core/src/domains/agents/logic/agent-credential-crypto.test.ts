import { beforeEach, describe, expect, it } from "vitest";
import { decryptAgentApiKey, encryptAgentApiKey } from "./agent-credential-crypto";

/**
 * Pure unit-level, no DB — real AES-256-GCM round trip, no mocked crypto
 * (task #13's own verification bar: this is the module whose whole job is
 * "actually encrypt," so faking the crypto here would prove nothing).
 */
describe("agent-credential-crypto", () => {
  beforeEach(() => {
    process.env.ACPROUTER_CREDENTIAL_ENCRYPTION_KEY = "test-encryption-key-not-for-real-use";
  });

  it("round-trips a real API key value through encrypt then decrypt", () => {
    const plaintext = "sk_live_1234567890abcdefEXAMPLE";
    const encrypted = encryptAgentApiKey(plaintext);

    expect(encrypted).not.toBe(plaintext);
    expect(encrypted).not.toContain(plaintext);

    const decrypted = decryptAgentApiKey(encrypted);
    expect(decrypted).toBe(plaintext);
  });

  it("produces a different ciphertext each call (random IV) for the same plaintext", () => {
    const plaintext = "sk_live_same_value_twice";
    const first = encryptAgentApiKey(plaintext);
    const second = encryptAgentApiKey(plaintext);
    expect(first).not.toBe(second);
    expect(decryptAgentApiKey(first)).toBe(plaintext);
    expect(decryptAgentApiKey(second)).toBe(plaintext);
  });

  it("throws rather than returning corrupted plaintext when the ciphertext is tampered with", () => {
    const encrypted = encryptAgentApiKey("sk_live_tamper_me");
    const payload = JSON.parse(encrypted) as { ciphertext: string };
    // Flip a bit of the DECODED ciphertext bytes (see the tag-tampering test
    // below for why byte-level, not trailing-base64-char) — GCM's auth tag
    // must fail to verify against the mutated bytes.
    const cipherBytes = Buffer.from(payload.ciphertext, "base64");
    cipherBytes[0] = cipherBytes[0] ^ 0xff;
    payload.ciphertext = cipherBytes.toString("base64");
    const tampered = JSON.stringify(payload);

    expect(() => decryptAgentApiKey(tampered)).toThrow();
  });

  it("throws rather than returning corrupted plaintext when the auth tag is tampered with", () => {
    const encrypted = encryptAgentApiKey("sk_live_tamper_tag");
    const payload = JSON.parse(encrypted) as { tag: string };
    // Flip a bit in the middle of the DECODED tag bytes, not the trailing
    // base64 character — GCM's 16-byte tag base64-encodes with a partial
    // final group, so the last character's unused bits don't always change
    // the decoded byte value when swapped for another character. Mutating
    // an interior byte guarantees the decoded tag actually differs.
    const tagBytes = Buffer.from(payload.tag, "base64");
    tagBytes[0] = tagBytes[0] ^ 0xff;
    payload.tag = tagBytes.toString("base64");
    const tampered = JSON.stringify(payload);

    expect(() => decryptAgentApiKey(tampered)).toThrow();
  });

  it("throws a clear, actionable error when no encryption key is configured", () => {
    process.env.ACPROUTER_CREDENTIAL_ENCRYPTION_KEY = "";
    expect(() => encryptAgentApiKey("sk_live_whatever")).toThrow(
      /ACPROUTER_CREDENTIAL_ENCRYPTION_KEY/,
    );
  });
});
