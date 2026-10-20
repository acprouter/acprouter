import type { AgentVO } from "@acprouter/contract";
import * as acp from "@agentclientprotocol/sdk";
import { ORPCError } from "@orpc/server";
import { eq } from "drizzle-orm";
import { generateNanoID } from "openlib/nanoid";
import { WebSocket } from "ws";
import { resolveOwnerId } from "../../../context";
import type { Database } from "../../../db";
import { acprouterAgentCredentials, acprouterAgents } from "../../../db/schema";
import type { AgentCredentialKind, AgentCredentialPO } from "../schema/agent-credentials";
import { streamFromWebSocket } from "./acp-ws-stream";
import { encryptAgentApiKey } from "./agent-credential-crypto";
import { toAgentVO } from "./agents-logic";
import type { StoredOAuthCredential } from "./stored-oauth-credential";

/**
 * `remote-acp` (Buda, spec §5.2/§2b Story B) — nothing to install, nothing
 * to spawn. This file owns the Add-flow validation dial
 * (`connectRemoteAcpAgent`) AND the low-level dial+handshake primitives
 * `sessions-logic.ts` reuses to open a fresh per-session connection
 * (`dialRemoteAcpSocket`/`performAcpInitializeHandshake`) — kept here rather
 * than duplicated there, since both call sites need the exact same
 * dial-then-`initialize`-with-timeout shape and the same three distinct
 * failure messages (spec §3: never a generic "failed").
 */

const ACP_INITIALIZE_TIMEOUT_MS = 10_000;

/**
 * Dials the raw WebSocket only — no ACP handshake yet. Split out from
 * `performAcpInitializeHandshake` because the two callers need different
 * `acp.client(...)` builders (a bare probe here vs. `sessions-logic.ts`'s
 * session-relay-wired one for real prompt-box traffic), and the SDK's
 * builder requires `.onNotification()`/`.onRequest()` to be registered
 * BEFORE `.connect(stream)` — so the socket must be dialled and handed off
 * as a `Stream` before either caller can finish building its own connection.
 */
export function dialRemoteAcpSocket(endpoint: string, apiKey: string): Promise<WebSocket> {
  return new Promise<WebSocket>((resolve, reject) => {
    const socket = new WebSocket(endpoint, { headers: { Authorization: `Bearer ${apiKey}` } });
    socket.once("open", () => resolve(socket));
    socket.once("error", (error: unknown) => {
      reject(
        new ORPCError("BAD_REQUEST", {
          message:
            `Could not reach "${endpoint}": ` +
            `${error instanceof Error ? error.message : String(error)}. ` +
            "Check the endpoint is correct and reachable.",
        }),
      );
    });
  });
}

/**
 * The real `initialize` round trip, with a bounded timeout — the exact same
 * dial-then-`initialize`-with-`AbortController`-timeout shape
 * `machine-bridge-connection.ts`'s `trackMachineBridgeConnection` already
 * uses for the INBOUND half of this pattern (spec §5.4: the direction of the
 * WS handshake is independent of the ACP role, so this OUTBOUND dial is the
 * same pattern pointed the other way).
 *
 * Distinguishes two failure classes on top of `dialRemoteAcpSocket`'s
 * "couldn't reach it at all": an `initialize` REQUEST rejecting, and an
 * `initialize` TIMEOUT. This is NOT what the task brief originally guessed
 * ("Buda's route validates the bearer token/agentId BEFORE upgrading") —
 * checked directly against Buda's own ACP WebSocket route: Buda's
 * `UPGRADE` handler calls `AcpServer...accept(client)` UNCONDITIONALLY,
 * before auth is even looked
 * up (its own doc comment explains why: awaiting the API-key lookup first
 * would risk losing the client's `initialize` message to the exact same
 * before-`await` race `machine-bridge-connection.ts` documents on ITS side
 * of this same problem). A bad `sk_...` key or `?agentId=` therefore always
 * completes the WebSocket upgrade and only surfaces once `initialize` runs —
 * `requireIdentity()` throws an `Error`, the SDK turns it into a real
 * JSON-RPC error response, and only THEN does the socket close. So on the
 * real backend this function targets, "wrong API key" and "initialize
 * genuinely errored for some other reason" are the same observable failure
 * class from here, both distinct from a timeout and both distinct from
 * never reaching the server at all.
 */
export async function performAcpInitializeHandshake(
  connection: acp.ClientConnection,
  socket: WebSocket,
  endpoint: string,
): Promise<acp.InitializeResponse> {
  const timeoutController = new AbortController();
  const timeout = setTimeout(() => timeoutController.abort(), ACP_INITIALIZE_TIMEOUT_MS);
  try {
    return await connection.agent.request(
      acp.methods.agent.initialize,
      { protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: {} },
      { cancellationSignal: timeoutController.signal },
    );
  } catch (error) {
    const timedOut = timeoutController.signal.aborted;
    connection.close(error);
    socket.close();
    throw new ORPCError("BAD_REQUEST", {
      message: timedOut
        ? `"${endpoint}" did not respond to the ACP handshake within ${ACP_INITIALIZE_TIMEOUT_MS / 1000}s.`
        : `"${endpoint}" rejected the connection during initialize: ` +
          `${error instanceof Error ? error.message : String(error)}. ` +
          "Check the API key is valid and the endpoint's ?agentId= names an agent you have access to.",
    });
  } finally {
    clearTimeout(timeout);
  }
}

export async function getAgentCredentialById(
  db: Database,
  credentialId: string,
): Promise<AgentCredentialPO | undefined> {
  const [row] = await db
    .select()
    .from(acprouterAgentCredentials)
    .where(eq(acprouterAgentCredentials.id, credentialId))
    .limit(1);
  return row;
}

export interface ConnectRemoteAcpAgentInput {
  label: string;
  endpoint: string;
  apiKey: string;
}

/**
 * The dial-then-persist tail shared by `connectRemoteAcpAgent` (manual
 * endpoint+API-key paste, task #13) and `connectOAuthRemoteAcpAgent` (Buda
 * OAuth connect, PUL-335): dial the endpoint with whatever bearer credential
 * the caller resolved, run the real `initialize` handshake, encrypt that
 * credential's SERIALIZED payload (a plain API key string for one caller, a
 * JSON-encoded `{accessToken, refreshToken, agentId}` blob for the other —
 * `encryptAgentApiKey` only cares that it's a string), and persist both rows
 * in one transaction. Pulled out once a second real caller needed the exact
 * same transaction shape — not a speculative abstraction, both call sites
 * already existed before this was factored out.
 */
async function dialAndPersistRemoteAcpAgent(
  db: Database,
  input: {
    label: string;
    endpoint: string;
    bearerToken: string;
    credentialKind: AgentCredentialKind;
    credentialPayload: string;
    credentialExpiresAt: Date | null;
  },
): Promise<AgentVO> {
  const socket = await dialRemoteAcpSocket(input.endpoint, input.bearerToken);
  const connection = acp.client({ name: "acprouter" }).connect(streamFromWebSocket(socket));
  const initializeResult = await performAcpInitializeHandshake(connection, socket, input.endpoint);
  connection.close();
  socket.close();

  // A missing `ACPROUTER_CREDENTIAL_ENCRYPTION_KEY` is a misconfiguration,
  // not this specific call's fault — still surfaced through the same
  // ORPCError shape as every other failure here (spec §3's failure-mode bar
  // applies to it too: an operator who forgot to set the key should see
  // why, not an opaque 500) rather than letting the bare `Error` from
  // `agent-credential-crypto.ts` bubble up unformatted.
  let encryptedPayload: string;
  try {
    encryptedPayload = encryptAgentApiKey(input.credentialPayload);
  } catch (error) {
    throw new ORPCError("INTERNAL_SERVER_ERROR", {
      message: error instanceof Error ? error.message : "Could not encrypt the agent credential.",
    });
  }
  const agentId = generateNanoID("agt_");
  const credentialId = generateNanoID("acrd_");

  // One transaction: `acprouter_agent_credentials.agent_id` has a NOT NULL
  // FK to `acprouter_agents.id` (schema/agent-credentials.ts), so the agent
  // row must exist before the credential row can reference it — inserting
  // both without a transaction would leave a real window where a crash
  // between the two inserts produces an agent row with no credential ever
  // able to reference it, or (the other order) a would-be FK violation.
  await db.transaction(async (tx) => {
    await tx.insert(acprouterAgents).values({
      id: agentId,
      ownerId: resolveOwnerId(),
      machineId: null,
      kind: "remote-acp",
      registrySlug: null,
      label: input.label,
      // `remote-acp` never has a `cwd` — Buda ignores it entirely (spec
      // §5.5a), and there is no local machine to have chosen one on (§5.6).
      cwd: null,
      endpoint: input.endpoint,
      credentialId,
      detectedVersion: null,
      capabilities: (initializeResult.agentCapabilities as Record<string, unknown>) ?? null,
      statusDetail: null,
      // A real `initialize` just succeeded against this exact endpoint+key —
      // "connected" is not optimistic here (spec §2b: "On success the card
      // goes green").
      status: "connected",
    });
    await tx.insert(acprouterAgentCredentials).values({
      id: credentialId,
      agentId,
      kind: input.credentialKind,
      encryptedPayload,
      expiresAt: input.credentialExpiresAt,
    });
  });

  const [row] = await db.select().from(acprouterAgents).where(eq(acprouterAgents.id, agentId));
  if (!row) {
    throw new ORPCError("INTERNAL_SERVER_ERROR", {
      message: "Connected, but the new agent row could not be read back.",
    });
  }
  return toAgentVO(row);
}

/**
 * Story B / spec §2b's Buda Add flow: "Submit connects immediately — there
 * is no detection step because there is no process to detect." Validates
 * the endpoint+key for REAL before persisting anything — a real dial and a
 * real `initialize`, not a format check — so a card never goes green over a
 * credential this Router never actually proved works (spec §3's "silent
 * auto-approval"-adjacent failure mode, applied to enrollment itself).
 *
 * The socket opened here is a THROWAWAY PROBE, not the connection a later
 * prompt-box session uses: `sessions-logic.ts#startAgentSession` dials its
 * own fresh connection per session (spec §11 point 6 / this domain's
 * `remote-session-registry.ts` doc comment explain why `remote-acp` doesn't
 * hold one persistent connection the way `bridged` does), so reusing this
 * one would leave it either idle forever or racing the first real session's
 * dial.
 */
export async function connectRemoteAcpAgent(
  db: Database,
  input: ConnectRemoteAcpAgentInput,
): Promise<AgentVO> {
  return dialAndPersistRemoteAcpAgent(db, {
    label: input.label,
    endpoint: input.endpoint,
    bearerToken: input.apiKey,
    credentialKind: "remote_api_key",
    credentialPayload: input.apiKey,
    credentialExpiresAt: null,
  });
}

/** Resolves Buda's public origin for both the OAuth authorize/token endpoints and the ACP WebSocket URL — same env var name as `packages/busabase-core/src/domains/agents/logic/buda-connection.ts#getBudaOAuthOrigin`, deliberately: one value can serve both apps in a shared deployment, and acprouter-core should not import the whole busabase-core package just for this one-liner (wrong direction of coupling between two independent domains). */
export function getBudaOAuthOrigin(): string {
  return new URL(process.env.BUDA_OAUTH_ORIGIN?.trim() || "https://buda.im").origin;
}

/** The `remote-acp` ACP WebSocket endpoint for a given Buda `agentId`, same shape `connectOAuthRemoteAcpAgent` persists into `acprouter_agents.endpoint` as the manual Add flow does for a pasted Buda URL. */
function getBudaAcpEndpoint(agentId: string): string {
  const url = new URL("/api/acp", getBudaOAuthOrigin());
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.searchParams.set("agentId", agentId);
  return url.toString();
}

export interface ConnectOAuthRemoteAcpAgentInput {
  label: string;
  agentId: string;
  accessToken: string;
  refreshToken: string;
  expiresAt: Date;
}

/**
 * OAuth counterpart to `connectRemoteAcpAgent`: instead of a
 * user-pasted endpoint + API key, the caller already completed the Buda
 * OAuth authorization-code exchange in its callback route and hands this
 * function the resulting token set. Builds the same `wss://.../api/acp?agentId=` endpoint
 * the manual flow's dialog pre-fills, dials it with the OAuth access token
 * as the bearer credential (Buda's ACP WebSocket route accepts any valid
 * bearer, OAuth-issued or API-key — same `Authorization: Bearer` contract,
 * confirmed against `remote-agents-logic.integration.test.ts`'s fixture),
 * and persists a `kind: "oauth"` credential row (`schema/agent-credentials
 * .ts`'s `AgentCredentialKind` already listed this kind before this task
 * ever inserted one) with `expiresAt` set — unlike `remote_api_key`, this
 * credential genuinely expires and carries a refresh token for later.
 */
export async function connectOAuthRemoteAcpAgent(
  db: Database,
  input: ConnectOAuthRemoteAcpAgentInput,
): Promise<AgentVO> {
  const credential: StoredOAuthCredential = {
    accessToken: input.accessToken,
    refreshToken: input.refreshToken,
    agentId: input.agentId,
  };
  return dialAndPersistRemoteAcpAgent(db, {
    label: input.label,
    endpoint: getBudaAcpEndpoint(input.agentId),
    bearerToken: input.accessToken,
    credentialKind: "oauth",
    credentialPayload: JSON.stringify(credential),
    credentialExpiresAt: input.expiresAt,
  });
}
