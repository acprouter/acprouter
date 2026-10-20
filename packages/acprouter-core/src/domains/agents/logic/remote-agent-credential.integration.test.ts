import { randomUUID } from "node:crypto";
import path from "node:path";
import * as acp from "@agentclientprotocol/sdk";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { WebSocketServer } from "ws";
import { type Database, getDb } from "../../../db";
import {
  acprouterAgentCredentials,
  acprouterAgentSessions,
  acprouterAgents,
} from "../../../db/schema";
import { streamFromWebSocket } from "./acp-ws-stream";
import { decryptAgentApiKey } from "./agent-credential-crypto";
import { resolveRemoteAcpBearerToken } from "./remote-agent-credential";
import { connectOAuthRemoteAcpAgent, getBudaOAuthOrigin } from "./remote-agents-logic";
import { endAgentSession, startAgentSession } from "./sessions-logic";

// Own file, not merged into remote-agents-logic.integration.test.ts — kept
// separate for file-size/focus reasons, not because of a missing dependency:
// `@acp-ui/core` is now linked into this worktree's node_modules (confirmed
// via `require.resolve`), so `sessions-logic.ts`'s `@acp-ui/core/prompt`
// import is no longer a reason to avoid exercising `startAgentSession` here.
// An in-memory PGLite instance (unique per run via a random id in the
// `memory://` name) rather than a scratch directory on disk — no
// filesystem writes to create or clean up, and no `rmSync` race with a
// concurrent test process using the real filesystem.
const SCRATCH_DIR = `memory://remote-agent-credential-test-${randomUUID()}`;
const INITIAL_AGENT_ID = "buda-agent-oauth-1";

describe("connectOAuthRemoteAcpAgent + OAuth refresh-at-dial (PUL-335)", () => {
  let db: Database;
  let wss: WebSocketServer;
  let acpPort: number;
  let httpServer: import("node:http").Server;
  let httpPort: number;
  let currentAccessToken = "initial-access-token";
  let refreshCallCount = 0;
  let observedAuthHeaders: (string | undefined)[] = [];

  beforeAll(async () => {
    process.env.PG_DATABASE_URL = `pglite://${SCRATCH_DIR}`;
    process.env.ACPROUTER_CREDENTIAL_ENCRYPTION_KEY = "test-encryption-key-not-for-real-use";
    db = await getDb({
      migrationsFolder: path.resolve(
        __dirname,
        "../../../../../../apps/acprouter/src/db/migrations",
      ),
    });

    // Fake Buda ACP WebSocket endpoint — same lazy-auth shape as the
    // existing fixture: the upgrade always succeeds, a bad/old bearer only
    // surfaces once `initialize` runs. Also answers `session/new` so
    // `startAgentSession` can be driven end-to-end against this fixture,
    // and records the raw `Authorization` header each connection actually
    // carried so a test can assert it was the REFRESHED token, not the
    // stale one `startAgentSession` was called with.
    wss = new WebSocketServer({ port: 0 });
    acpPort = (wss.address() as { port: number }).port;
    wss.on("connection", (socket, req) => {
      const authHeader = req.headers.authorization;
      observedAuthHeaders.push(authHeader);
      const stream = streamFromWebSocket(socket);
      acp
        .agent({ name: "fake-buda" })
        .onRequest(acp.methods.agent.initialize, () => {
          if (authHeader !== `Bearer ${currentAccessToken}`) {
            throw new Error("Unauthorized: stale or invalid OAuth access token.");
          }
          return { protocolVersion: acp.PROTOCOL_VERSION, agentCapabilities: {} };
        })
        .onRequest(acp.methods.agent.session.new, () => ({
          sessionId: `fake-session-${randomUUID()}`,
        }))
        .connect(stream);
    });

    // Fake Buda `/api/oauth/token` refresh endpoint — a real HTTP server,
    // not a mocked fetch. Each call rotates the access token (real OAuth
    // refresh-token semantics: the old access token is now stale, proving
    // the dial path picks up the NEW one).
    const { createServer } = await import("node:http");
    httpServer = createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => {
        body += chunk;
      });
      req.on("end", () => {
        const params = new URLSearchParams(body);
        if (req.url !== "/api/oauth/token" || params.get("grant_type") !== "refresh_token") {
          res.writeHead(400).end();
          return;
        }
        refreshCallCount += 1;
        currentAccessToken = `refreshed-access-token-${refreshCallCount}`;
        res.writeHead(200, { "content-type": "application/json" }).end(
          JSON.stringify({
            access_token: currentAccessToken,
            refresh_token: `refreshed-refresh-token-${refreshCallCount}`,
            expires_in: 3600,
          }),
        );
      });
    });
    await new Promise<void>((resolve) => httpServer.listen(0, resolve));
    httpPort = (httpServer.address() as { port: number }).port;
    process.env.BUDA_OAUTH_ORIGIN = `http://127.0.0.1:${httpPort}`;
  });

  afterAll(async () => {
    wss.close();
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    // In-memory PGLite — nothing on disk to remove.
  });

  afterEach(async () => {
    // `startAgentSession` leaves behind an `acprouter_agent_sessions` row
    // (`endAgentSession` marks it "ended", it never deletes it) — must go
    // before `acprouterAgents` or the FK constraint rejects the agent delete.
    await db.delete(acprouterAgentSessions);
    await db.delete(acprouterAgentCredentials);
    await db.delete(acprouterAgents);
    refreshCallCount = 0;
    observedAuthHeaders = [];
  });

  it("getBudaOAuthOrigin reads BUDA_OAUTH_ORIGIN", () => {
    expect(getBudaOAuthOrigin()).toBe(`http://127.0.0.1:${httpPort}`);
  });

  it("persists an encrypted JSON credential envelope, never a bare bearer token", async () => {
    currentAccessToken = "initial-access-token";
    // `connectOAuthRemoteAcpAgent` builds its own `wss://<budaOrigin>/api/acp` endpoint from
    // `BUDA_OAUTH_ORIGIN` — point that at the fake ACP server for this assertion by overriding
    // the origin resolution indirectly isn't possible without a real Buda-shaped host, so this
    // test instead calls the lower-level persist path through the public API with a same-origin
    // ACP+token server pair.
    process.env.BUDA_OAUTH_ORIGIN = `http://127.0.0.1:${acpPort}`;
    const agent = await connectOAuthRemoteAcpAgent(db, {
      label: "Buda",
      agentId: INITIAL_AGENT_ID,
      accessToken: currentAccessToken,
      refreshToken: "initial-refresh-token",
      expiresAt: new Date(Date.now() + 3600_000),
    });
    process.env.BUDA_OAUTH_ORIGIN = `http://127.0.0.1:${httpPort}`;

    expect(agent.kind).toBe("remote-acp");
    expect(agent.status).toBe("connected");

    const [credRow] = await db
      .select()
      .from(acprouterAgentCredentials)
      .where(eq(acprouterAgentCredentials.agentId, agent.id));
    expect(credRow?.kind).toBe("oauth");
    expect(credRow?.expiresAt).not.toBeNull();
    // Proves it's encrypted (not a passthrough) AND that the stored
    // plaintext is the JSON envelope, never the bare access token used as
    // a direct bearer-token string.
    expect(credRow?.encryptedPayload).not.toContain(currentAccessToken);
    const plaintext = decryptAgentApiKey(credRow?.encryptedPayload ?? "");
    const parsed = JSON.parse(plaintext);
    expect(parsed).toMatchObject({
      accessToken: currentAccessToken,
      refreshToken: "initial-refresh-token",
      agentId: INITIAL_AGENT_ID,
    });
  });

  it("resolveRemoteAcpBearerToken returns the stored access token unchanged while still fresh", async () => {
    currentAccessToken = "initial-access-token";
    process.env.BUDA_OAUTH_ORIGIN = `http://127.0.0.1:${acpPort}`;
    const agent = await connectOAuthRemoteAcpAgent(db, {
      label: "Buda",
      agentId: INITIAL_AGENT_ID,
      accessToken: currentAccessToken,
      refreshToken: "initial-refresh-token",
      expiresAt: new Date(Date.now() + 3600_000),
    });
    process.env.BUDA_OAUTH_ORIGIN = `http://127.0.0.1:${httpPort}`;

    const [agentRow] = await db
      .select()
      .from(acprouterAgents)
      .where(eq(acprouterAgents.id, agent.id));
    const [credRow] = await db
      .select()
      .from(acprouterAgentCredentials)
      .where(eq(acprouterAgentCredentials.id, agentRow?.credentialId ?? ""));
    expect(credRow).toBeDefined();
    if (!credRow) return;

    const token = await resolveRemoteAcpBearerToken(db, credRow);
    expect(token).toBe("initial-access-token");
    expect(refreshCallCount).toBe(0);
  });

  it("refreshes a near-expiry OAuth credential against a real HTTP token endpoint and persists the new token", async () => {
    currentAccessToken = "initial-access-token";
    process.env.BUDA_OAUTH_ORIGIN = `http://127.0.0.1:${acpPort}`;
    const agent = await connectOAuthRemoteAcpAgent(db, {
      label: "Buda",
      agentId: INITIAL_AGENT_ID,
      accessToken: currentAccessToken,
      refreshToken: "initial-refresh-token",
      // Already inside the refresh skew window.
      expiresAt: new Date(Date.now() + 1_000),
    });
    process.env.BUDA_OAUTH_ORIGIN = `http://127.0.0.1:${httpPort}`;

    const [agentRow] = await db
      .select()
      .from(acprouterAgents)
      .where(eq(acprouterAgents.id, agent.id));
    const [credRow] = await db
      .select()
      .from(acprouterAgentCredentials)
      .where(eq(acprouterAgentCredentials.id, agentRow?.credentialId ?? ""));
    expect(credRow).toBeDefined();
    if (!credRow) return;

    const token = await resolveRemoteAcpBearerToken(db, credRow);
    expect(token).toBe("refreshed-access-token-1");
    expect(refreshCallCount).toBe(1);

    const [updatedCredRow] = await db
      .select()
      .from(acprouterAgentCredentials)
      .where(eq(acprouterAgentCredentials.id, credRow.id));
    const plaintext = decryptAgentApiKey(updatedCredRow?.encryptedPayload ?? "");
    expect(JSON.parse(plaintext)).toMatchObject({
      accessToken: "refreshed-access-token-1",
      refreshToken: "refreshed-refresh-token-1",
    });
    expect(updatedCredRow?.expiresAt?.getTime()).toBeGreaterThan(Date.now());
  });

  it("serializes two concurrent refreshes of the same credential into one real token-endpoint call", async () => {
    currentAccessToken = "initial-access-token";
    process.env.BUDA_OAUTH_ORIGIN = `http://127.0.0.1:${acpPort}`;
    const agent = await connectOAuthRemoteAcpAgent(db, {
      label: "Buda",
      agentId: INITIAL_AGENT_ID,
      accessToken: currentAccessToken,
      refreshToken: "initial-refresh-token",
      expiresAt: new Date(Date.now() + 1_000),
    });
    process.env.BUDA_OAUTH_ORIGIN = `http://127.0.0.1:${httpPort}`;

    const [agentRow] = await db
      .select()
      .from(acprouterAgents)
      .where(eq(acprouterAgents.id, agent.id));
    const [credRow] = await db
      .select()
      .from(acprouterAgentCredentials)
      .where(eq(acprouterAgentCredentials.id, agentRow?.credentialId ?? ""));
    expect(credRow).toBeDefined();
    if (!credRow) return;

    const [tokenA, tokenB] = await Promise.all([
      resolveRemoteAcpBearerToken(db, credRow),
      resolveRemoteAcpBearerToken(db, credRow),
    ]);
    expect(tokenA).toBe(tokenB);
    // The single-flight dedup means only ONE real refresh call happened,
    // not two racing for the same (single-use) refresh token.
    expect(refreshCallCount).toBe(1);
  });

  it("surfaces a clear error when Buda rejects the refresh token, without crashing the process", async () => {
    currentAccessToken = "initial-access-token";
    process.env.BUDA_OAUTH_ORIGIN = `http://127.0.0.1:${acpPort}`;
    const agent = await connectOAuthRemoteAcpAgent(db, {
      label: "Buda",
      agentId: INITIAL_AGENT_ID,
      accessToken: currentAccessToken,
      refreshToken: "a-refresh-token-the-fake-server-will-reject",
      expiresAt: new Date(Date.now() + 1_000),
    });

    // Point at a server that always 400s the refresh request, instead of the happy-path fixture.
    const { createServer } = await import("node:http");
    const rejectingServer = createServer((_req, res) => res.writeHead(400).end());
    await new Promise<void>((resolve) => rejectingServer.listen(0, resolve));
    const rejectingPort = (rejectingServer.address() as { port: number }).port;
    process.env.BUDA_OAUTH_ORIGIN = `http://127.0.0.1:${rejectingPort}`;

    const [agentRow] = await db
      .select()
      .from(acprouterAgents)
      .where(eq(acprouterAgents.id, agent.id));
    const [credRow] = await db
      .select()
      .from(acprouterAgentCredentials)
      .where(eq(acprouterAgentCredentials.id, agentRow?.credentialId ?? ""));
    expect(credRow).toBeDefined();
    if (!credRow) return;

    await expect(resolveRemoteAcpBearerToken(db, credRow)).rejects.toThrow(
      /reconnect it from the agents page|buda authorization expired/i,
    );

    await new Promise<void>((resolve) => rejectingServer.close(() => resolve()));
    process.env.BUDA_OAUTH_ORIGIN = `http://127.0.0.1:${httpPort}`;
  });

  it("startAgentSession dials with the REFRESHED access token (not the stale one it was called with) and completes session/new", async () => {
    currentAccessToken = "initial-access-token";
    process.env.BUDA_OAUTH_ORIGIN = `http://127.0.0.1:${acpPort}`;
    const agent = await connectOAuthRemoteAcpAgent(db, {
      label: "Buda",
      agentId: INITIAL_AGENT_ID,
      accessToken: currentAccessToken,
      refreshToken: "initial-refresh-token",
      // Already inside the refresh skew window — the real-session dial
      // below must trigger a refresh before it ever opens its WebSocket.
      expiresAt: new Date(Date.now() + 1_000),
    });

    // From here on, `getBudaOAuthOrigin()` (read by `startAgentSession`'s
    // dial path via `agent.endpoint`, already built against `acpPort`) and
    // the refresh endpoint both need to be reachable — `agent.endpoint` was
    // frozen at connect time as `wss://127.0.0.1:<acpPort>/api/acp`, and the
    // refresh call separately goes to `BUDA_OAUTH_ORIGIN`.
    process.env.BUDA_OAUTH_ORIGIN = `http://127.0.0.1:${httpPort}`;

    observedAuthHeaders = [];
    const { sessionId } = await startAgentSession(db, agent.id);
    expect(sessionId).toMatch(/^fake-session-/);
    expect(refreshCallCount).toBe(1);

    // The ONE real WebSocket connection this dial opened must have carried
    // the refreshed token as its actual `Authorization` header — not the
    // stale `initial-access-token` `startAgentSession` had no handle on
    // directly (it only ever receives `agent.id`), and not the raw JSON
    // credential envelope mistaken for a bearer token.
    expect(observedAuthHeaders).toEqual([`Bearer refreshed-access-token-1`]);

    const [credRow] = await db
      .select()
      .from(acprouterAgentCredentials)
      .where(eq(acprouterAgentCredentials.agentId, agent.id));
    const plaintext = decryptAgentApiKey(credRow?.encryptedPayload ?? "");
    expect(JSON.parse(plaintext)).toMatchObject({ accessToken: "refreshed-access-token-1" });

    await endAgentSession(db, { agentId: agent.id, sessionId });
  });

  it("rejects a session dial when agent.credentialId points at a credential belonging to a DIFFERENT agent", async () => {
    currentAccessToken = "initial-access-token";
    process.env.BUDA_OAUTH_ORIGIN = `http://127.0.0.1:${acpPort}`;
    // Two real, independently-connected agents, each with its own credential row.
    const agentA = await connectOAuthRemoteAcpAgent(db, {
      label: "Buda A",
      agentId: `${INITIAL_AGENT_ID}-a`,
      accessToken: currentAccessToken,
      refreshToken: "refresh-token-a",
      expiresAt: new Date(Date.now() + 3600_000),
    });
    const agentB = await connectOAuthRemoteAcpAgent(db, {
      label: "Buda B",
      agentId: `${INITIAL_AGENT_ID}-b`,
      accessToken: currentAccessToken,
      refreshToken: "refresh-token-b",
      expiresAt: new Date(Date.now() + 3600_000),
    });
    process.env.BUDA_OAUTH_ORIGIN = `http://127.0.0.1:${httpPort}`;

    const [agentBRow] = await db
      .select()
      .from(acprouterAgents)
      .where(eq(acprouterAgents.id, agentB.id));
    expect(agentBRow).toBeDefined();
    if (!agentBRow) return;

    // Simulate agent A's row having been mutated (e.g. by a bug elsewhere)
    // to point at agent B's credential — a wrong, cross-agent association
    // `startAgentSession` must refuse to use rather than silently dialing
    // with a different agent's bearer token.
    await db
      .update(acprouterAgents)
      .set({ credentialId: agentBRow.credentialId })
      .where(eq(acprouterAgents.id, agentA.id));

    await expect(startAgentSession(db, agentA.id)).rejects.toThrow(
      /stored credential is missing|reconnect it from the agents page/i,
    );
  });
});
