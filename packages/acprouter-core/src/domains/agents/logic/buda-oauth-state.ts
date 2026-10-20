import "server-only";

import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

// PKCE + signed-state-cookie helper for the Buda OAuth connect flow.
// Shared here so every Router edition can reuse the same state validation.
// userId AND spaceId bind the state to whoever started the flow and which
// tenant it was started for; the callback must reject if either changed
// (switched user, switched active space, or lost membership in the frozen
// space) rather than silently falling back to whatever space/user resolves
// at exchange time.

const COOKIE_TTL_MS = 10 * 60 * 1000;

export interface BudaOAuthState {
  state: string;
  codeVerifier: string;
  redirectUri: string;
  userId: string;
  spaceId: string;
  createdAt: number;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isBudaOAuthState(value: unknown): value is BudaOAuthState {
  const v = value as Partial<BudaOAuthState> | null;
  return (
    typeof v === "object" &&
    v !== null &&
    isNonEmptyString(v.state) &&
    isNonEmptyString(v.codeVerifier) &&
    isNonEmptyString(v.redirectUri) &&
    isNonEmptyString(v.userId) &&
    isNonEmptyString(v.spaceId) &&
    typeof v.createdAt === "number" &&
    Number.isFinite(v.createdAt)
  );
}

const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;

// No app secret like busabase's BETTER_AUTH_SECRET exists here, so this uses its own env var.
const secret = () => process.env.ACPROUTER_OAUTH_STATE_SECRET;

const sign = (value: string) => {
  const key = secret();
  if (!key) {
    throw new Error("ACPROUTER_OAUTH_STATE_SECRET is required for the Buda OAuth connect flow.");
  }
  return createHmac("sha256", key).update(value).digest("base64url");
};

export function createBudaOAuthState(userId: string, spaceId: string, redirectUri: string) {
  const codeVerifier = randomBytes(32).toString("base64url");
  const payload: BudaOAuthState = {
    state: randomBytes(24).toString("base64url"),
    codeVerifier,
    redirectUri,
    userId,
    spaceId,
    createdAt: Date.now(),
  };
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return {
    payload,
    cookie: `${encoded}.${sign(encoded)}`,
    codeChallenge: createHash("sha256").update(codeVerifier).digest("base64url"),
  };
}

/**
 * Rejects malformed shapes, bad signatures, expired state, and
 * clock-skew-abusing future timestamps. Requires EXACTLY two
 * dot-separated, non-empty base64url segments — an extra `.suffix` or a
 * non-base64url signature is rejected before ever reaching
 * `timingSafeEqual`, and the Buffer-byte-length check (not the JS string
 * length) runs first so a same-character-length-but-different-byte-length
 * Unicode-ish signature can never reach `timingSafeEqual` with mismatched
 * buffer sizes (which throws instead of returning false).
 */
export function readBudaOAuthState(cookie: string | undefined): BudaOAuthState | null {
  if (!cookie) return null;
  const parts = cookie.split(".");
  if (parts.length !== 2) return null;
  const [encoded, signature] = parts;
  if (!encoded || !signature) return null;
  if (!BASE64URL_PATTERN.test(encoded) || !BASE64URL_PATTERN.test(signature)) return null;

  const expected = sign(encoded);
  const signatureBuffer = Buffer.from(signature, "base64url");
  const expectedBuffer = Buffer.from(expected, "base64url");
  if (
    signatureBuffer.length !== expectedBuffer.length ||
    !timingSafeEqual(signatureBuffer, expectedBuffer)
  ) {
    return null;
  }

  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (!isBudaOAuthState(payload)) return null;
  const age = Date.now() - payload.createdAt;
  return age >= 0 && age <= COOKIE_TTL_MS ? payload : null;
}
