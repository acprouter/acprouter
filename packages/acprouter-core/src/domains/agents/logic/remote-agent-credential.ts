import { ORPCError } from "@orpc/server";
import { eq } from "drizzle-orm";
import type { Database } from "../../../db";
import { acprouterAgentCredentials } from "../../../db/schema";
import type { AgentCredentialPO } from "../schema/agent-credentials";
import { decryptAgentApiKey, encryptAgentApiKey } from "./agent-credential-crypto";
import { getBudaOAuthOrigin } from "./remote-agents-logic";
import {
  parseBudaRefreshTokenResponse,
  type StoredOAuthCredential,
  StoredOAuthCredentialSchema,
  safeJsonParse,
} from "./stored-oauth-credential";

/**
 * PUL-335 — resolves the REAL bearer token a `remote-acp` dial should
 * present, for either credential kind `acprouter_agent_credentials.kind`
 * can hold today (`remote_api_key` / `oauth`). Split out of
 * `sessions-logic.ts`'s dial path so that file (and
 * `remote-agents-logic.ts`'s initial-connect probe) never has to special-
 * case "is this envelope a plain string or JSON?" inline — the credential's
 * `kind` column is the one source of truth for how to decode its
 * `encryptedPayload`, exactly like `AgentCredentialKind`'s own doc comment
 * says a `remote_api_key` payload is a bare secret and an `oauth` payload
 * is `./stored-oauth-credential.ts`'s `StoredOAuthCredential` JSON shape. A
 * caller that decrypted an `oauth` row and used the raw plaintext as the
 * bearer token would be sending Buda
 * `{"accessToken":"...","refreshToken":"...",...}` as the `Authorization`
 * header value — this module exists specifically so that mistake has
 * nowhere to happen.
 */

function parseStoredOAuthCredential(plaintext: string): StoredOAuthCredential {
  const parsed = safeJsonParse(plaintext);
  const result = StoredOAuthCredentialSchema.safeParse(parsed);
  if (!result.success) {
    throw new ORPCError("PRECONDITION_FAILED", {
      message:
        "This agent's stored Buda credential is corrupted — reconnect it from the Agents page.",
    });
  }
  return result.data;
}

const OAUTH_CLIENT_ID = "acprouter-cloud";
/** Refresh this far ahead of the real expiry — matches `busabase-core`'s own `getBudaConnection` refresh-skew window, so both apps treat "about to expire" the same way against the same server. */
const REFRESH_SKEW_MS = 60_000;

/**
 * Real HTTP round trip to Buda's `/api/oauth/token` with
 * `grant_type=refresh_token` — same request shape
 * `packages/busabase-core/src/domains/agents/logic/buda-connection.ts#refresh`
 * already uses successfully for the same server. Thrown error is
 * deliberately generic/user-facing (never leaks the refresh token or raw
 * HTTP body) — the caller (`resolveRemoteAcpBearerToken`) decides what to do
 * with it (currently: surface it as the reason the dial can't proceed).
 */
async function refreshBudaOAuthToken(
  refreshToken: string,
): Promise<{ accessToken: string; refreshToken: string; expiresAt: Date }> {
  const budaOrigin = getBudaOAuthOrigin();
  let response: Response;
  try {
    response = await fetch(new URL("/api/oauth/token", budaOrigin), {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        client_id: OAUTH_CLIENT_ID,
        resource: new URL("/api/acp", budaOrigin).toString(),
      }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    throw new ORPCError("BAD_REQUEST", {
      message: "Could not reach Buda to refresh this connection. Try again later.",
    });
  }
  if (!response.ok) {
    throw new ORPCError("PRECONDITION_FAILED", {
      message: "Buda authorization expired. Reconnect Buda from the Agents page.",
    });
  }
  // `response.json()` throws on a non-JSON body (e.g. an HTML error page
  // from a proxy) — read as text and parse+validate safely so a malformed
  // or unexpected-shape response can never crash this call or silently
  // accept e.g. a zero/negative `expires_in` as "never expires". `agent_id`
  // is intentionally NOT required here (unlike the initial exchange): Buda
  // only echoes it back on a refresh when the grant rotated it.
  let text: string;
  try {
    text = await response.text();
  } catch {
    throw new ORPCError("BAD_REQUEST", {
      message: "Could not read Buda's refresh response. Try again later.",
    });
  }
  const body = parseBudaRefreshTokenResponse(safeJsonParse(text));
  if (!body) {
    throw new ORPCError("PRECONDITION_FAILED", {
      message:
        "Buda returned an invalid refreshed credential. Reconnect Buda from the Agents page.",
    });
  }
  return {
    accessToken: body.access_token,
    refreshToken: body.refresh_token,
    expiresAt: new Date(Date.now() + body.expires_in * 1000),
  };
}

/**
 * Same-process fast path for concurrent dials of one credential: avoids
 * opening a row-locking transaction per caller when they're racing in the
 * same event loop. The transaction below (`FOR UPDATE` + re-read) is what
 * actually prevents reuse of an already-rotated refresh token — this map
 * only saves redundant work locally, it is not the correctness mechanism.
 * `globalThis`-backed so it survives Next.js dev-server HMR.
 */
type GlobalWithRefreshLocks = typeof globalThis & {
  __acprouterOAuthRefreshes?: Map<string, Promise<string>>;
};

function refreshLocks(): Map<string, Promise<string>> {
  const g = globalThis as GlobalWithRefreshLocks;
  if (!g.__acprouterOAuthRefreshes) g.__acprouterOAuthRefreshes = new Map();
  return g.__acprouterOAuthRefreshes;
}

/**
 * Resolves the REAL bearer token to dial `agent.endpoint` with, decrypting
 * and (for `oauth` credentials) refreshing-if-needed first. `oauth` rows are
 * re-read under `SELECT ... FOR UPDATE` before refreshing — the caller's
 * `credential` argument may be a stale snapshot (read before another
 * process already rotated the single-use refresh token), so refreshing
 * must be decided from the DB row under lock, not from the argument.
 */
export async function resolveRemoteAcpBearerToken(
  db: Database,
  credential: AgentCredentialPO,
): Promise<string> {
  const plaintext = decryptAgentApiKey(credential.encryptedPayload);
  if (credential.kind === "remote_api_key" || credential.kind === "enrollment_token") {
    return plaintext;
  }

  const stored = parseStoredOAuthCredential(plaintext);
  const freshEnough =
    credential.expiresAt !== null && credential.expiresAt.getTime() - REFRESH_SKEW_MS > Date.now();
  if (freshEnough) return stored.accessToken;

  const locks = refreshLocks();
  const inFlight = locks.get(credential.id);
  if (inFlight) return inFlight;

  const task = db.transaction(async (tx) => {
    const [current] = await tx
      .select()
      .from(acprouterAgentCredentials)
      .where(eq(acprouterAgentCredentials.id, credential.id))
      .for("update");
    // Re-check the row still belongs to the same agent the caller validated
    // against before this transaction opened — the id alone isn't proof of
    // that once a row can be re-read later than it was first looked up.
    if (!current || current.agentId !== credential.agentId) {
      throw new ORPCError("PRECONDITION_FAILED", {
        message: "This agent's credential no longer exists — reconnect it from the Agents page.",
      });
    }
    const currentPlaintext = decryptAgentApiKey(current.encryptedPayload);
    const currentStored = parseStoredOAuthCredential(currentPlaintext);
    const stillFreshEnough =
      current.expiresAt !== null && current.expiresAt.getTime() - REFRESH_SKEW_MS > Date.now();
    // Another process may have already refreshed this row while this call
    // was waiting on the lock — if so, use what it wrote instead of
    // refreshing again with the now-stale refresh token this call started
    // with.
    if (stillFreshEnough) return currentStored.accessToken;

    const refreshed = await refreshBudaOAuthToken(currentStored.refreshToken);
    const next: StoredOAuthCredential = {
      accessToken: refreshed.accessToken,
      refreshToken: refreshed.refreshToken,
      agentId: currentStored.agentId,
    };
    await tx
      .update(acprouterAgentCredentials)
      .set({
        encryptedPayload: encryptAgentApiKey(JSON.stringify(next)),
        expiresAt: refreshed.expiresAt,
      })
      .where(eq(acprouterAgentCredentials.id, credential.id));
    return refreshed.accessToken;
  });
  locks.set(credential.id, task);
  try {
    return await task;
  } finally {
    // Only this call's own task is cleared — a slower, now-superseded
    // task finishing later must not clobber a newer one that already
    // started its own refresh after this credential changed again.
    if (locks.get(credential.id) === task) locks.delete(credential.id);
  }
}
