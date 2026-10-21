import { randomUUID } from "node:crypto";
import path from "node:path";
import * as acp from "@agentclientprotocol/sdk";
import { AcpServer } from "@agentclientprotocol/sdk/experimental/server";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import { runWithMemberContext } from "../../../context";
import { type Database, getDb } from "../../../db";
import {
  acprouterAgentCredentials,
  acprouterAgentSessionEvents,
  acprouterAgentSessions,
  acprouterAgents,
  acprouterConsumerApiKeys,
  acprouterMachines,
} from "../../../db/schema";
import { streamFromWebSocket } from "./acp-ws-stream";
import { createConsumerAcpAgentApp, resolveConsumerAcpAuth } from "./consumer-acp-connection";
import { mintConsumerApiKey } from "./consumer-api-keys-logic";
import { registerMachineBridge } from "./machine-bridge-registry";
import { connectRemoteAcpAgent } from "./remote-agents-logic";
import { closeRemoteSessionConnection } from "./remote-session-registry";
import { emitSessionUpdate, flushSessionEvents } from "./session-relay-registry";

describe("consumer session/load with real PGlite and WebSockets", () => {
  let db: Database;
  let upstream: WebSocketServer;
  let consumers: WebSocketServer;
  const sockets = new Set<WebSocket>();
  const sessions = new Set<string>();
  let newCalls = 0;
  let loadCalls = 0;
  let promptCalls = 0;
  let cancellations: string[] = [];
  let loadSupported = true;
  let waitForLoad: (() => Promise<void>) | undefined;
  const metadata = {
    modes: {
      currentModeId: "normal",
      availableModes: [{ id: "normal", name: "Normal" }],
    },
    configOptions: [
      {
        id: "model",
        name: "Model",
        type: "select" as const,
        currentValue: "model-a",
        options: [{ value: "model-a", name: "Model A" }],
      },
    ],
  };

  beforeAll(async () => {
    process.env.PG_DATABASE_URL = `pglite://memory://consumer-load-${randomUUID()}`;
    process.env.ACPROUTER_CREDENTIAL_ENCRYPTION_KEY = "consumer-load-isolated-test-key";
    db = await getDb({
      migrationsFolder: path.resolve(
        __dirname,
        "../../../../../../apps/acprouter/src/db/migrations",
      ),
    });
    upstream = new WebSocketServer({ port: 0 });
    upstream.on("connection", (socket, request) => {
      sockets.add(socket);
      const oldCli = request.url?.includes("oldCli=1");
      let app = acp
        .agent({ name: "fixture-runtime" })
        .onRequest(acp.methods.agent.initialize, () => ({
          protocolVersion: acp.PROTOCOL_VERSION,
          agentCapabilities: { loadSession: loadSupported },
        }))
        .onRequest(acp.methods.agent.session.new, () => {
          newCalls += 1;
          const sessionId = `load-test-${randomUUID()}`;
          sessions.add(sessionId);
          return { sessionId, ...metadata };
        })
        .onRequest(acp.methods.agent.session.prompt, async (ctx) => {
          promptCalls += 1;
          for (const text of ["first", "second"]) {
            await ctx.client.notify(acp.methods.client.session.update, {
              sessionId: ctx.params.sessionId,
              update: {
                sessionUpdate: "agent_message_chunk",
                content: { type: "text", text },
              },
            });
          }
          return { stopReason: "end_turn" };
        })
        .onNotification(acp.methods.agent.session.cancel, (ctx) => {
          cancellations.push(ctx.params.sessionId);
        });
      if (!oldCli) {
        app = app.onRequest(acp.methods.agent.session.load, async (ctx) => {
          loadCalls += 1;
          await waitForLoad?.();
          // A real remote load commonly replays its own transcript. The Router
          // must neither store it again nor send it alongside its durable log.
          await ctx.client.notify(acp.methods.client.session.update, {
            sessionId: ctx.params.sessionId,
            update: {
              sessionUpdate: "agent_message_chunk",
              content: { type: "text", text: "underlying history replay" },
            },
          });
          return metadata;
        });
      }
      app.connect(streamFromWebSocket(socket));
    });
    consumers = new WebSocketServer({ port: 0 });
    consumers.on("connection", (socket, request) => {
      sockets.add(socket);
      const req = new Request(new URL(request.url ?? "", "http://localhost"), {
        headers: { authorization: request.headers.authorization ?? "" },
      });
      const dbPromise = Promise.resolve(db);
      new AcpServer({
        agent: createConsumerAcpAgentApp(dbPromise, resolveConsumerAcpAuth(dbPromise, req)),
      })
        .prepareWebSocketUpgrade()
        .accept(socket);
    });
  });

  afterEach(async () => {
    for (const id of sessions) {
      await flushSessionEvents(id);
      closeRemoteSessionConnection(id);
    }
    for (const socket of sockets) socket.terminate();
    sockets.clear();
    sessions.clear();
    await db.delete(acprouterConsumerApiKeys);
    await db.delete(acprouterAgentSessionEvents);
    await db.delete(acprouterAgentSessions);
    await db.delete(acprouterAgentCredentials);
    await db.delete(acprouterAgents);
    await db.delete(acprouterMachines);
    newCalls = 0;
    loadCalls = 0;
    promptCalls = 0;
    cancellations = [];
    loadSupported = true;
    waitForLoad = undefined;
  });

  afterAll(() => {
    upstream.close();
    consumers.close();
  });

  async function waitUntil(predicate: () => boolean | Promise<boolean>): Promise<void> {
    const deadline = Date.now() + 3000;
    while (!(await predicate())) {
      if (Date.now() > deadline) throw new Error("Fixture condition timed out");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  async function createAgent(ownerId = "tenant-a") {
    return runWithMemberContext({ db, ownerId }, async () => {
      const agent = await connectRemoteAcpAgent(db, {
        label: "Recovery fixture",
        endpoint: `ws://127.0.0.1:${(upstream.address() as { port: number }).port}`,
        apiKey: "isolated-test-token",
      });
      const { rawKey } = await mintConsumerApiKey(db, agent.id, "test", "http://localhost");
      return { agentId: agent.id, rawKey };
    });
  }

  async function connectConsumer(agent: { agentId: string; rawKey: string }) {
    const socket = new WebSocket(
      `ws://127.0.0.1:${(consumers.address() as { port: number }).port}?agentId=${agent.agentId}`,
      { headers: { authorization: `Bearer ${agent.rawKey}` } },
    );
    sockets.add(socket);
    const updates: acp.SessionNotification[] = [];
    const stream = await new Promise<ReturnType<typeof streamFromWebSocket>>((resolve, reject) => {
      socket.once("open", () => resolve(streamFromWebSocket(socket)));
      socket.once("error", reject);
    });
    const client = acp
      .client({ name: "reconnecting-consumer" })
      .onNotification(acp.methods.client.session.update, (ctx) => {
        updates.push(ctx.params);
      })
      .connect(stream);
    const initialized = await client.agent.request(acp.methods.agent.initialize, {
      protocolVersion: acp.PROTOCOL_VERSION,
      clientCapabilities: {},
    });
    expect(initialized.agentCapabilities).toEqual({
      loadSession: true,
      promptCapabilities: { image: false, audio: false, embeddedContext: false },
    });
    return { client, socket, updates };
  }

  function load(client: acp.ClientConnection, sessionId: string) {
    return client.agent.request(acp.methods.agent.session.load, {
      sessionId,
      cwd: "/consumer-must-not-select-server-cwd",
      mcpServers: [],
    });
  }

  function prompt(client: acp.ClientConnection, sessionId: string) {
    return client.agent.request(acp.methods.agent.session.prompt, {
      sessionId,
      prompt: [{ type: "text", text: "continue" }],
    });
  }

  async function history(sessionId: string) {
    await flushSessionEvents(sessionId);
    return db
      .select()
      .from(acprouterAgentSessionEvents)
      .where(eq(acprouterAgentSessionEvents.sessionId, sessionId))
      .orderBy(acprouterAgentSessionEvents.seq);
  }

  it("reconnects, replays once before response, and restores remote runtime without a new session", async () => {
    const agent = await createAgent();
    const first = await connectConsumer(agent);
    const created = await first.client.agent.request(acp.methods.agent.session.new, {
      cwd: "/",
      mcpServers: [],
    });
    expect(created).toEqual({ sessionId: created.sessionId });
    await prompt(first.client, created.sessionId);
    const original = await history(created.sessionId);
    expect(original).toHaveLength(3);
    first.client.close();
    first.socket.close();

    const second = await connectConsumer(agent);
    expect(await load(second.client, created.sessionId)).toEqual({});
    expect(second.updates).toEqual(first.updates);
    expect(await history(created.sessionId)).toEqual(original);
    expect(loadCalls).toBe(0);
    second.updates.length = 0;
    closeRemoteSessionConnection(created.sessionId);
    expect(await load(second.client, created.sessionId)).toEqual({});
    expect(second.updates).toEqual(first.updates);
    expect(await history(created.sessionId)).toEqual(original);
    expect(loadCalls).toBe(1);
    expect(newCalls).toBe(1);

    // Simulate the lost process-local sequence counter with durable history intact.
    const state = globalThis as typeof globalThis & {
      __acprouterSessionPersistence?: Map<string, unknown>;
    };
    state.__acprouterSessionPersistence?.delete(created.sessionId);
    await prompt(second.client, created.sessionId);
    expect((await history(created.sessionId)).map((row) => row.seq)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(promptCalls).toBe(2);
  });

  it("rejects unsupported remote restore without creating or replaying anything", async () => {
    const agent = await createAgent();
    const consumer = await connectConsumer(agent);
    const { sessionId } = await consumer.client.agent.request(acp.methods.agent.session.new, {
      cwd: "/",
      mcpServers: [],
    });
    await prompt(consumer.client, sessionId);
    const original = await history(sessionId);
    consumer.updates.length = 0;
    closeRemoteSessionConnection(sessionId);
    loadSupported = false;
    await expect(load(consumer.client, sessionId)).rejects.toThrow("does not support reopening");
    expect(consumer.updates).toEqual([]);
    expect(await history(sessionId)).toEqual(original);
    expect(newCalls).toBe(1);
    expect(loadCalls).toBe(0);
  });

  it("denies same-tenant other-agent, foreign-tenant, unknown, and ended sessions uniformly", async () => {
    const agent = await createAgent();
    const consumer = await connectConsumer(agent);
    const deniedIds = ["unknown-session"];
    for (const owner of ["tenant-a", "tenant-b"]) {
      const other = await createAgent(owner);
      const otherConsumer = await connectConsumer(other);
      const { sessionId } = await otherConsumer.client.agent.request(
        acp.methods.agent.session.new,
        {
          cwd: "/",
          mcpServers: [],
        },
      );
      deniedIds.push(sessionId);
    }
    const own = await consumer.client.agent.request(acp.methods.agent.session.new, {
      cwd: "/",
      mcpServers: [],
    });
    await db
      .update(acprouterAgentSessions)
      .set({ status: "ended" })
      .where(eq(acprouterAgentSessions.id, own.sessionId));
    deniedIds.push(own.sessionId);
    for (const id of deniedIds) {
      await expect(load(consumer.client, id)).rejects.toThrow(
        "Session is unavailable for this agent.",
      );
    }
    await expect(prompt(consumer.client, own.sessionId)).rejects.toThrow("Session is unavailable");
    expect(consumer.updates).toEqual([]);
    expect(loadCalls).toBe(0);
    expect(promptCalls).toBe(0);
  });

  it("cancellation during a delayed restore wins and cancels the eventual runtime", async () => {
    const agent = await createAgent();
    const consumer = await connectConsumer(agent);
    const { sessionId } = await consumer.client.agent.request(acp.methods.agent.session.new, {
      cwd: "/",
      mcpServers: [],
    });
    closeRemoteSessionConnection(sessionId);
    let releaseLoad = () => {};
    const gate = new Promise<void>((resolve) => {
      releaseLoad = resolve;
    });
    waitForLoad = () => gate;
    const loading = load(consumer.client, sessionId);
    const rejected = expect(loading).rejects.toThrow("Session is unavailable");
    await waitUntil(() => loadCalls === 1);
    await consumer.client.agent.notify(acp.methods.agent.session.cancel, { sessionId });
    await waitUntil(async () => {
      // No connection was registered while loading, so cancel persists its
      // terminal intent before the eventual runtime can receive it.
      const [row] = await db
        .select()
        .from(acprouterAgentSessions)
        .where(eq(acprouterAgentSessions.id, sessionId));
      return row.status === "ended";
    });
    releaseLoad();
    await rejected;
    await waitUntil(() => cancellations.includes(sessionId));
    await expect(prompt(consumer.client, sessionId)).rejects.toThrow("Session is unavailable");
    expect(newCalls).toBe(1);
    expect(promptCalls).toBe(0);
    expect(consumer.updates).toEqual([]);
  });

  it("gives an actionable error for an old bridge without session/load", async () => {
    const agent = await createAgent();
    const machineId = randomUUID();
    await db.insert(acprouterMachines).values({
      id: machineId,
      ownerId: "tenant-a",
      label: "old-cli",
      tunnelId: randomUUID(),
    });
    await db
      .update(acprouterAgents)
      .set({ kind: "bridged", machineId, registrySlug: "codex-acp" })
      .where(eq(acprouterAgents.id, agent.agentId));
    const socket = new WebSocket(
      `ws://127.0.0.1:${(upstream.address() as { port: number }).port}?oldCli=1`,
    );
    sockets.add(socket);
    const connection = await new Promise<acp.ClientConnection>((resolve, reject) => {
      socket.once("open", () => {
        resolve(
          acp
            .client({ name: "old-bridge-router" })
            .onNotification(acp.methods.client.session.update, (ctx) => {
              emitSessionUpdate(Promise.resolve(db), ctx.params.sessionId, ctx.params.update);
            })
            .connect(streamFromWebSocket(socket)),
        );
      });
      socket.once("error", reject);
    });
    registerMachineBridge(machineId, connection);
    const consumer = await connectConsumer(agent);
    const { sessionId } = await consumer.client.agent.request(acp.methods.agent.session.new, {
      cwd: "/",
      mcpServers: [],
    });
    await expect(load(consumer.client, sessionId)).rejects.toThrow("Update the CLI and reconnect");
    expect(newCalls).toBe(1);
    expect(consumer.updates).toEqual([]);
  });
});
