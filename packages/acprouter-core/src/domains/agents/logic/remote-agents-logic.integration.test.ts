import { rmSync } from "node:fs";
import path from "node:path";
import * as acp from "@agentclientprotocol/sdk";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { WebSocketServer } from "ws";
import { type Database, getDb } from "../../../db";
import {
  acprouterAgentCredentials,
  acprouterAgentSessionEvents,
  acprouterAgentSessions,
  acprouterAgents,
} from "../../../db/schema";
import { streamFromWebSocket } from "./acp-ws-stream";
import { decryptAgentApiKey } from "./agent-credential-crypto";
import { connectRemoteAcpAgent } from "./remote-agents-logic";
import { endAgentSession, promptAgentSession, startAgentSession } from "./sessions-logic";

const SCRATCH_DIR = ".data/remote-agents-logic-test";
const VALID_API_KEY = "sk_test_valid_key_123";
const VALID_AGENT_ID = "test-buda-agent-id";

/**
 * Real PGLite + a real WS server shaped exactly like Buda's REAL documented
 * contract (`ws://<host>/api/acp?agentId=<id>` +
 * `Authorization: Bearer sk_...`) and its REAL lazy-auth behavior
 * (every WebSocket upgrade is
 * accepted unconditionally; a bad key/agentId only surfaces once
 * `initialize` runs, as a thrown `Error` the SDK turns into a real JSON-RPC
 * error response. This fixture reproduces THAT behavior on purpose (not a
 * simpler "reject before upgrade" shortcut) so the assertions below exercise
 * `remote-agents-logic.ts`'s actual failure-classification logic against the
 * real shape it has to handle, not a shape it was guessed to handle.
 */
describe("connectRemoteAcpAgent + remote-acp session flow (task #13)", () => {
  let db: Database;
  let wss: WebSocketServer;
  let port: number;
  let closedPort: number;

  beforeAll(async () => {
    rmSync(SCRATCH_DIR, { recursive: true, force: true });
    process.env.PG_DATABASE_URL = `pglite://${SCRATCH_DIR}`;
    process.env.ACPROUTER_CREDENTIAL_ENCRYPTION_KEY = "test-encryption-key-not-for-real-use";
    db = await getDb({
      migrationsFolder: path.resolve(
        __dirname,
        "../../../../../../apps/acprouter/src/db/migrations",
      ),
    });

    wss = new WebSocketServer({ port: 0 });
    port = (wss.address() as { port: number }).port;
    wss.on("connection", (socket, req) => {
      const url = new URL(req.url ?? "", "http://localhost");
      const agentId = url.searchParams.get("agentId");
      const authHeader = req.headers.authorization;
      const stream = streamFromWebSocket(socket);
      acp
        .agent({ name: "fake-buda" })
        .onRequest(acp.methods.agent.initialize, () => {
          // Mirrors `acp-agent-implementation.ts#requireIdentity`: a bad
          // credential throws HERE, not before the socket opened.
          if (authHeader !== `Bearer ${VALID_API_KEY}` || agentId !== VALID_AGENT_ID) {
            throw new Error(
              "Unauthorized: connect with `Authorization: Bearer sk_...` and `?agentId=<id>`.",
            );
          }
          return {
            protocolVersion: acp.PROTOCOL_VERSION,
            agentCapabilities: {
              loadSession: true,
              promptCapabilities: { image: false, audio: false, embeddedContext: false },
            },
          };
        })
        .onRequest(acp.methods.agent.session.new, () => ({ sessionId: "sess_fake_buda_1" }))
        .onRequest(acp.methods.agent.session.prompt, async (ctx) => {
          await ctx.client.notify(acp.methods.client.session.update, {
            sessionId: ctx.params.sessionId,
            update: {
              sessionUpdate: "agent_message_chunk",
              content: { type: "text", text: "hello from buda" },
            },
          });
          return { stopReason: "end_turn" };
        })
        .connect(stream);
    });

    // A real, temporarily-bound port that is then freed — guarantees nothing
    // is listening on it (ECONNREFUSED), a stronger and more portable
    // "unreachable host" fixture than guessing at an unused port number.
    const probe = new WebSocketServer({ port: 0 });
    closedPort = (probe.address() as { port: number }).port;
    await new Promise<void>((resolve) => probe.close(() => resolve()));
  });

  afterAll(async () => {
    wss.close();
    rmSync(SCRATCH_DIR, { recursive: true, force: true });
  });

  afterEach(async () => {
    // Order matters — FK order mirrors `sessions-logic.integration.test.ts`'s
    // own `afterEach`: session events reference sessions, sessions and
    // credentials both reference agents.
    await db.delete(acprouterAgentSessionEvents);
    await db.delete(acprouterAgentSessions);
    await db.delete(acprouterAgentCredentials);
    await db.delete(acprouterAgents);
  });

  function validEndpoint(): string {
    return `ws://127.0.0.1:${port}?agentId=${VALID_AGENT_ID}`;
  }

  describe("connectRemoteAcpAgent", () => {
    it("a successful dial persists an encrypted credential row and a connected agent row", async () => {
      const endpoint = validEndpoint();
      const agent = await connectRemoteAcpAgent(db, {
        label: "Buda",
        endpoint,
        apiKey: VALID_API_KEY,
      });

      expect(agent.kind).toBe("remote-acp");
      expect(agent.status).toBe("connected");
      expect(agent.machineId).toBeNull();
      expect(agent.cwd).toBeNull();
      expect(agent.registrySlug).toBeNull();

      const [agentRow] = await db
        .select()
        .from(acprouterAgents)
        .where(eq(acprouterAgents.id, agent.id));
      expect(agentRow?.endpoint).toBe(endpoint);
      expect(agentRow?.credentialId).not.toBeNull();

      const [credRow] = await db
        .select()
        .from(acprouterAgentCredentials)
        .where(eq(acprouterAgentCredentials.agentId, agent.id));
      expect(credRow).toBeDefined();
      expect(credRow?.kind).toBe("remote_api_key");
      // Proves this is actually encrypted, not a passthrough/base64 no-op —
      // the literal API key must not appear anywhere in the stored payload.
      expect(credRow?.encryptedPayload).not.toBe(VALID_API_KEY);
      expect(credRow?.encryptedPayload).not.toContain(VALID_API_KEY);
      expect(decryptAgentApiKey(credRow?.encryptedPayload ?? "")).toBe(VALID_API_KEY);
    });

    it("a wrong API key surfaces a specific initialize-rejection error and persists nothing", async () => {
      const endpoint = validEndpoint();
      await expect(
        connectRemoteAcpAgent(db, { label: "Buda", endpoint, apiKey: "sk_wrong_key" }),
      ).rejects.toThrow(/rejected the connection during initialize/i);

      expect(await db.select().from(acprouterAgents)).toHaveLength(0);
      expect(await db.select().from(acprouterAgentCredentials)).toHaveLength(0);
    });

    it("a wrong agentId surfaces the same initialize-rejection class and persists nothing", async () => {
      const endpoint = `ws://127.0.0.1:${port}?agentId=some-other-agent`;
      await expect(
        connectRemoteAcpAgent(db, { label: "Buda", endpoint, apiKey: VALID_API_KEY }),
      ).rejects.toThrow(/rejected the connection during initialize/i);

      expect(await db.select().from(acprouterAgents)).toHaveLength(0);
    });

    it("an unreachable host surfaces a distinct 'could not reach' error and persists nothing", async () => {
      const endpoint = `ws://127.0.0.1:${closedPort}?agentId=${VALID_AGENT_ID}`;
      await expect(
        connectRemoteAcpAgent(db, { label: "Buda", endpoint, apiKey: VALID_API_KEY }),
      ).rejects.toThrow(/could not reach/i);

      expect(await db.select().from(acprouterAgents)).toHaveLength(0);
    });
  });

  describe("remote-acp session connection resolution", () => {
    it("startAgentSession dials a fresh connection, promptAgentSession streams a real reply, endAgentSession closes it and a subsequent prompt fails cleanly", async () => {
      const endpoint = validEndpoint();
      const agent = await connectRemoteAcpAgent(db, {
        label: "Buda",
        endpoint,
        apiKey: VALID_API_KEY,
      });

      const { sessionId } = await startAgentSession(db, agent.id);
      expect(sessionId).toBe("sess_fake_buda_1");

      const seenByBrowser: unknown[] = [];
      for await (const event of promptAgentSession(db, {
        agentId: agent.id,
        sessionId,
        text: "hi",
      })) {
        seenByBrowser.push(event);
      }
      expect(seenByBrowser).toEqual([
        {
          type: "session_update",
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "hello from buda" },
          },
        },
        { type: "turn_ended", stopReason: "end_turn" },
      ]);

      const result = await endAgentSession(db, { agentId: agent.id, sessionId });
      expect(result.ok).toBe(true);

      // The per-session connection was closed by `endAgentSession` — a
      // second prompt against the same (now-gone) sessionId must fail
      // cleanly (a thrown/rejected PRECONDITION_FAILED from
      // `resolveConnectionForExistingSession`), never hang.
      await expect(async () => {
        for await (const _event of promptAgentSession(db, {
          agentId: agent.id,
          sessionId,
          text: "again",
        })) {
          // no-op — should never yield, the generator should throw before
          // its first `next()` resolves.
        }
      }).rejects.toThrow(/no live connection/i);
    });
  });
});
