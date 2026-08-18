import { rmSync } from "node:fs";
import path from "node:path";
import * as acp from "@agentclientprotocol/sdk";
import { AcpServer } from "@agentclientprotocol/sdk/experimental/server";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import { type Database, getDb } from "../../../db";
import {
  acprouterAgentSessionEvents,
  acprouterAgentSessions,
  acprouterAgents,
  acprouterConsumerApiKeys,
  acprouterMachines,
} from "../../../db/schema";
import { streamFromWebSocket } from "./acp-ws-stream";
import { listAgents } from "./agents-logic";
import { createConsumerAcpAgentApp, resolveConsumerAcpAuth } from "./consumer-acp-connection";
import { mintConsumerApiKey } from "./consumer-api-keys-logic";
import { acceptMachineBridgeConnection } from "./machine-bridge-connection";
import { mintEnrollmentToken, redeemEnrollmentToken } from "./machines-logic";

const SCRATCH_DIR = ".data/consumer-acp-connection-test";

/**
 * Proves task #14's actual deliverable: a real external ACP consumer,
 * speaking real ACP over a real WebSocket to `wss://.../api/acp?agentId=...`,
 * driving a real `bridged` agent end to end — `initialize` → `session/new` →
 * `session/prompt`, including a real `session/request_permission` round trip
 * answered by the CONSUMER'S OWN `ctx.client`, not the dashboard's queue.
 *
 * Mirrors `machine-bridge-connection.integration.test.ts`'s house style: a
 * bare `WebSocketServer` driving the same functions the real Next.js route
 * (`apps/acprouter/src/app/api/acp/route.ts`) calls, a fake in-process ACP
 * agent standing in for a real bridged machine (same fixture shape as that
 * file's `buildFakeMachineAgent`, extended with a real `session/new`/
 * `session/prompt` implementation), and a real consumer-side `acp.client()`
 * app standing in for Zed/Busabase/a script — nothing about the ACP
 * transport, the credential check, or the relay is mocked.
 */
describe("createConsumerAcpAgentApp / resolveConsumerAcpAuth", () => {
  let db: Database;
  let bridgeWss: WebSocketServer;
  let bridgePort: number;
  let consumerWss: WebSocketServer;
  let consumerPort: number;

  beforeAll(async () => {
    rmSync(SCRATCH_DIR, { recursive: true, force: true });
    process.env.PG_DATABASE_URL = `pglite://${SCRATCH_DIR}`;
    db = await getDb({
      migrationsFolder: path.resolve(
        __dirname,
        "../../../../../../apps/acprouter/src/db/migrations",
      ),
    });

    // The machine-bridge leg (task #7) — sets up a real `bridged` agent this
    // test's consumer will drive.
    bridgeWss = new WebSocketServer({ port: 0 });
    bridgePort = (bridgeWss.address() as { port: number }).port;
    bridgeWss.on("connection", (socket, req) => {
      const machineId = new URL(req.url ?? "", "http://localhost").searchParams.get("machineId");
      acceptMachineBridgeConnection(Promise.resolve(db), machineId, socket);
    });

    // The new consumer-facing leg (task #14) — the SAME call
    // `apps/acprouter/src/app/api/acp/route.ts`'s `UPGRADE` makes, against a
    // bare `WebSocketServer` instead of `next-ws` (a `WebSocketServer`'s
    // `connection` socket is already open/upgraded the same way `next-ws`
    // hands `UPGRADE` an already-open socket — same same-tick contract).
    consumerWss = new WebSocketServer({ port: 0 });
    consumerPort = (consumerWss.address() as { port: number }).port;
    consumerWss.on("connection", (socket, req) => {
      const url = new URL(req.url ?? "", "http://localhost");
      const request = new Request(url, {
        headers: req.headers.authorization ? { authorization: req.headers.authorization } : {},
      });
      const dbPromise = Promise.resolve(db);
      const identityPromise = resolveConsumerAcpAuth(dbPromise, request);
      const server = new AcpServer({
        agent: createConsumerAcpAgentApp(dbPromise, identityPromise),
      });
      server.prepareWebSocketUpgrade().accept(socket);
    });
  });

  afterAll(async () => {
    bridgeWss.close();
    consumerWss.close();
    rmSync(SCRATCH_DIR, { recursive: true, force: true });
  });

  afterEach(async () => {
    await db.delete(acprouterConsumerApiKeys);
    await db.delete(acprouterAgentSessionEvents);
    await db.delete(acprouterAgentSessions);
    await db.delete(acprouterAgents);
    await db.delete(acprouterMachines);
  });

  async function waitFor(predicate: () => Promise<boolean>, timeoutMs = 3000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await predicate()) return;
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error(`condition not met within ${timeoutMs}ms`);
  }

  /** A real ACP AGENT app standing in for a bridged machine's CLI — implements enough of `session/new`/`session/prompt` (including a mid-turn permission round trip) to drive this test end to end. */
  function buildFakeBridgedMachine(): acp.AgentApp {
    return acp
      .agent({ name: "fake-cli" })
      .onRequest(acp.methods.agent.initialize, () => ({
        protocolVersion: acp.PROTOCOL_VERSION,
        agentCapabilities: { loadSession: false },
        authMethods: [],
        _meta: {
          registrySlug: "claude-acp",
          cwd: "/home/user/projects/demo",
          detectedVersion: "1.4.0",
          authState: "ok",
          authDetail: null,
        },
      }))
      .onRequest(acp.methods.agent.session.new, () => ({ sessionId: "sess_consumer_e2e_1" }))
      .onRequest(acp.methods.agent.session.prompt, async (ctx) => {
        const outcome = await ctx.client.request(acp.methods.client.session.requestPermission, {
          sessionId: ctx.params.sessionId,
          toolCall: {
            toolCallId: "tc_consumer_e2e",
            title: "run `echo hi`",
            kind: "execute",
            status: "pending",
          },
          options: [
            { optionId: "allow", name: "Allow", kind: "allow_once" },
            { optionId: "deny", name: "Deny", kind: "reject_once" },
          ],
        });
        machinePermissionOutcomes.push(outcome);
        await ctx.client.notify(acp.methods.client.session.update, {
          sessionId: ctx.params.sessionId,
          update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "PONG" } },
        });
        return { stopReason: "end_turn" };
      });
  }

  let machinePermissionOutcomes: acp.RequestPermissionResponse[] = [];

  async function connectFakeBridgedMachine(): Promise<string> {
    const minted = await mintEnrollmentToken(db, {}, "http://example.test");
    const redeemed = await redeemEnrollmentToken(db, {
      token: minted.token,
      label: "test-machine",
    });

    const cliSocket = new WebSocket(`ws://127.0.0.1:${bridgePort}?machineId=${redeemed.machineId}`);
    const agentApp = buildFakeBridgedMachine();
    await new Promise<acp.AgentConnection>((resolve, reject) => {
      cliSocket.once("open", () => resolve(agentApp.connect(streamFromWebSocket(cliSocket))));
      cliSocket.once("error", reject);
    });

    await waitFor(async () => {
      const agents = await listAgents(db);
      return agents.some((a) => a.machineId === redeemed.machineId);
    });
    const agents = await listAgents(db);
    const agent = agents.find((a) => a.machineId === redeemed.machineId);
    if (!agent) throw new Error("fake bridged agent never reported in");
    return agent.id;
  }

  it("rejects a wrong bearer credential at `initialize`, never at the upgrade itself", async () => {
    const agentId = await connectFakeBridgedMachine();
    await mintConsumerApiKey(db, agentId, undefined, "http://127.0.0.1:15420");

    const consumerSocket = new WebSocket(`ws://127.0.0.1:${consumerPort}?agentId=${agentId}`, {
      headers: { authorization: "Bearer ack_totally_wrong" },
    });
    const stream = await new Promise<ReturnType<typeof streamFromWebSocket>>((resolve, reject) => {
      consumerSocket.once("open", () => resolve(streamFromWebSocket(consumerSocket)));
      consumerSocket.once("error", reject);
    });

    const client = acp.client({ name: "test-consumer" }).connect(stream);
    await expect(
      client.agent.request(acp.methods.agent.initialize, {
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: {},
      }),
    ).rejects.toBeTruthy();

    client.close();
    consumerSocket.close();
  });

  it("a real minted key drives session/new -> session/prompt end to end, relaying session/update and a permission round trip to the CONSUMER's own ctx.client", async () => {
    machinePermissionOutcomes = [];
    const agentId = await connectFakeBridgedMachine();
    const minted = await mintConsumerApiKey(db, agentId, "test key", "http://127.0.0.1:15420");
    expect(minted.connectionUrl).toBe(`ws://127.0.0.1:15420/api/acp?agentId=${agentId}`);

    const consumerSocket = new WebSocket(`ws://127.0.0.1:${consumerPort}?agentId=${agentId}`, {
      headers: { authorization: `Bearer ${minted.rawKey}` },
    });
    const stream = await new Promise<ReturnType<typeof streamFromWebSocket>>((resolve, reject) => {
      consumerSocket.once("open", () => resolve(streamFromWebSocket(consumerSocket)));
      consumerSocket.once("error", reject);
    });

    const receivedUpdates: acp.SessionNotification[] = [];
    const client = acp
      .client({ name: "test-consumer" })
      .onNotification(acp.methods.client.session.update, (ctx) => {
        receivedUpdates.push(ctx.params);
      })
      .onRequest(acp.methods.client.session.requestPermission, () => ({
        outcome: { outcome: "selected", optionId: "allow" },
      }))
      .connect(stream);

    const initResult = await client.agent.request(acp.methods.agent.initialize, {
      protocolVersion: acp.PROTOCOL_VERSION,
      clientCapabilities: {},
    });
    expect(initResult.agentCapabilities?.loadSession).toBe(false);

    const { sessionId } = await client.agent.request(acp.methods.agent.session.new, {
      cwd: "/",
      mcpServers: [],
    });
    expect(sessionId).toBe("sess_consumer_e2e_1");

    const promptResult = await client.agent.request(acp.methods.agent.session.prompt, {
      sessionId,
      prompt: [{ type: "text", text: "hi" }],
    });
    expect(promptResult.stopReason).toBe("end_turn");

    // The consumer's OWN ctx.client received the real session/update — not
    // the dashboard's oRPC queue, which nothing in this test ever touches.
    expect(receivedUpdates).toEqual([
      {
        sessionId,
        update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "PONG" } },
      },
    ]);
    // The permission answer the CONSUMER gave really reached the spawned
    // agent (the fake bridged machine) — proving the round trip is real, not
    // just "the consumer's own request resolved."
    expect(machinePermissionOutcomes).toEqual([
      { outcome: { outcome: "selected", optionId: "allow" } },
    ]);

    client.close();
    consumerSocket.close();
  });
});
