import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createBudaOAuthState, readBudaOAuthState } from "./buda-oauth-state";

describe("Buda OAuth state (PUL-335)", () => {
  const originalSecret = process.env.ACPROUTER_OAUTH_STATE_SECRET;

  beforeEach(() => {
    process.env.ACPROUTER_OAUTH_STATE_SECRET = "test-acprouter-oauth-secret";
  });

  afterEach(() => {
    process.env.ACPROUTER_OAUTH_STATE_SECRET = originalSecret;
  });

  it("round-trips signed PKCE state bound to both user and space, and rejects tampering", () => {
    const flow = createBudaOAuthState(
      "user_123",
      "space_456",
      "https://acprouter.test/api/agents/buda/oauth/callback",
    );
    expect(readBudaOAuthState(flow.cookie)).toMatchObject({
      state: flow.payload.state,
      codeVerifier: flow.payload.codeVerifier,
      redirectUri: "https://acprouter.test/api/agents/buda/oauth/callback",
      userId: "user_123",
      spaceId: "space_456",
    });
    expect(readBudaOAuthState(`${flow.cookie}tampered`)).toBeNull();
  });

  it("rejects a missing or malformed cookie", () => {
    expect(readBudaOAuthState(undefined)).toBeNull();
    expect(readBudaOAuthState("not-a-valid-cookie")).toBeNull();
    expect(readBudaOAuthState("")).toBeNull();
  });

  it("rejects a cookie with an extra dot-separated segment", () => {
    const flow = createBudaOAuthState("user_123", "space_456", "https://acprouter.test/callback");
    expect(readBudaOAuthState(`${flow.cookie}.extra`)).toBeNull();
  });

  it("rejects a signature containing non-base64url characters", () => {
    const flow = createBudaOAuthState("user_123", "space_456", "https://acprouter.test/callback");
    const [encoded] = flow.cookie.split(".");
    expect(readBudaOAuthState(`${encoded}.not base64url!!`)).toBeNull();
  });

  it("rejects a well-signed payload missing required fields", () => {
    const key = process.env.ACPROUTER_OAUTH_STATE_SECRET as string;
    const incomplete = { state: "s", createdAt: Date.now() };
    const encoded = Buffer.from(JSON.stringify(incomplete)).toString("base64url");
    const signature = createHmac("sha256", key).update(encoded).digest("base64url");
    expect(readBudaOAuthState(`${encoded}.${signature}`)).toBeNull();
  });

  it("rejects a well-signed payload with empty string fields", () => {
    const key = process.env.ACPROUTER_OAUTH_STATE_SECRET as string;
    const emptyFields = {
      state: "",
      codeVerifier: "",
      redirectUri: "",
      userId: "",
      spaceId: "",
      createdAt: Date.now(),
    };
    const encoded = Buffer.from(JSON.stringify(emptyFields)).toString("base64url");
    const signature = createHmac("sha256", key).update(encoded).digest("base64url");
    expect(readBudaOAuthState(`${encoded}.${signature}`)).toBeNull();
  });

  it("rejects a well-signed payload with a future createdAt timestamp", () => {
    const flow = createBudaOAuthState("user_123", "space_456", "https://acprouter.test/callback");
    const future = { ...flow.payload, createdAt: Date.now() + 60 * 1000 };
    const encoded = Buffer.from(JSON.stringify(future)).toString("base64url");
    const key = process.env.ACPROUTER_OAUTH_STATE_SECRET as string;
    const signature = createHmac("sha256", key).update(encoded).digest("base64url");
    expect(readBudaOAuthState(`${encoded}.${signature}`)).toBeNull();
  });

  it("rejects an expired cookie", () => {
    const flow = createBudaOAuthState("user_123", "space_456", "https://acprouter.test/callback");
    const expired = {
      ...flow.payload,
      createdAt: Date.now() - 11 * 60 * 1000,
    };
    const encoded = Buffer.from(JSON.stringify(expired)).toString("base64url");
    // Re-sign the tampered-but-expired payload so only the TTL check (not
    // the signature check) is what rejects it — proves the TTL is actually
    // enforced, not just piggy-backing on the tamper check above.
    const key = process.env.ACPROUTER_OAUTH_STATE_SECRET as string;
    const signature = createHmac("sha256", key).update(encoded).digest("base64url");
    expect(readBudaOAuthState(`${encoded}.${signature}`)).toBeNull();
  });
});
