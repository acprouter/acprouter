import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as acp from "@agentclientprotocol/sdk";
import { AcpServer } from "@agentclientprotocol/sdk/experimental/server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import { createBridgeAgentApp } from "../../../../../../apps/acprouter-cli/src/daemon/bridge-agent";
import { type Database, getDb } from "../../../db";
import { streamFromWebSocket } from "./acp-ws-stream";
import { listAgents } from "./agents-logic";
import { createConsumerAcpAgentApp, resolveConsumerAcpAuth } from "./consumer-acp-connection";
import { mintConsumerApiKey } from "./consumer-api-keys-logic";
import { acceptMachineBridgeConnection } from "./machine-bridge-connection";
import { getMachineBridge } from "./machine-bridge-registry";
import { mintEnrollmentToken, redeemEnrollmentToken } from "./machines-logic";
import { listSessionEvents } from "./session-events-logic";
import { flushSessionEvents } from "./session-relay-registry";

const FIXTURE = fileURLToPath(
  new URL(
    "../../../../../../apps/acprouter-cli/src/daemon/__fixtures__/fake-stdio-agent.mjs",
    import.meta.url,
  ),
);

// This acceptance path uses both production WebSocket handlers, the real CLI
// bridge, a real stdio subprocess and an isolated migrated database. Only the
// final model is deterministic; no production bridge, credentials or LLM calls.
describe("consumer → Router → CLI bridge session recovery", () => {
  let scratch: string;
  let db: Database;
  let bridgeWss: WebSocketServer;
  let consumerWss: WebSocketServer;
  const sockets = new Set<WebSocket>();
  const bridges: ReturnType<typeof createBridgeAgentApp>[] = [];

  beforeAll(async () => {
    scratch = mkdtempSync(path.join(tmpdir(), "acprouter-recovery-acceptance-"));
    process.env.PG_DATABASE_URL = "pglite://memory://consumer-bridge-recovery";
    db = await getDb({
      migrationsFolder: path.resolve(
        __dirname,
        "../../../../../../apps/acprouter/src/db/migrations",
      ),
    });
    bridgeWss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await new Promise<void>((resolve) => bridgeWss.once("listening", resolve));
    bridgeWss.on("connection", (socket, request) => {
      sockets.add(socket);
      const machineId = new URL(request.url ?? "", "http://localhost").searchParams.get(
        "machineId",
      );
      acceptMachineBridgeConnection(Promise.resolve(db), machineId, socket);
    });
    consumerWss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await new Promise<void>((resolve) => consumerWss.once("listening", resolve));
    consumerWss.on("connection", (socket, request) => {
      sockets.add(socket);
      const url = new URL(request.url ?? "", "http://localhost");
      const identity = resolveConsumerAcpAuth(
        Promise.resolve(db),
        new Request(url, { headers: { authorization: request.headers.authorization ?? "" } }),
      );
      new AcpServer({ agent: createConsumerAcpAgentApp(Promise.resolve(db), identity) })
        .prepareWebSocketUpgrade()
        .accept(socket);
    });
  });

  afterAll(async () => {
    for (const bridge of bridges) await bridge.disposeAllSessions();
    for (const socket of sockets) socket.terminate();
    if (bridgeWss) await new Promise<void>((resolve) => bridgeWss.close(() => resolve()));
    if (consumerWss) await new Promise<void>((resolve) => consumerWss.close(() => resolve()));
    if (scratch) rmSync(scratch, { recursive: true, force: true });
  });

  const waitUntil = async (check: () => boolean | Promise<boolean>) => {
    await expect.poll(check, { timeout: 8000, interval: 25 }).toBe(true);
  };

  const connectBridge = async (
    machineId: string,
    bridge: ReturnType<typeof createBridgeAgentApp>,
  ) => {
    const previous = getMachineBridge(machineId)?.connection;
    const address = bridgeWss.address() as { port: number };
    const socket = new WebSocket(`ws://127.0.0.1:${address.port}?machineId=${machineId}`);
    sockets.add(socket);
    await new Promise<void>((resolve, reject) => {
      socket.once("error", reject);
      socket.once("open", () => {
        bridge.app.connect(streamFromWebSocket(socket));
        resolve();
      });
    });
    await waitUntil(() => {
      const current = getMachineBridge(machineId)?.connection;
      return current !== undefined && current !== previous;
    });
    return socket;
  };

  const connectConsumer = async (agentId: string, key: string) => {
    const address = consumerWss.address() as { port: number };
    const socket = new WebSocket(`ws://127.0.0.1:${address.port}?agentId=${agentId}`, {
      headers: { authorization: `Bearer ${key}` },
    });
    sockets.add(socket);
    const messages: string[] = [];
    let permissions = 0;
    const client = await new Promise<acp.ClientConnection>((resolve, reject) => {
      socket.once("error", reject);
      socket.once("open", () => {
        resolve(
          acp
            .client({ name: "recovery-acceptance" })
            .onNotification(acp.methods.client.session.update, (ctx) => {
              const update = ctx.params.update;
              if (
                update.sessionUpdate === "agent_message_chunk" &&
                update.content.type === "text"
              ) {
                messages.push(update.content.text);
              }
            })
            .onRequest(acp.methods.client.session.requestPermission, () => {
              permissions += 1;
              return { outcome: { outcome: "selected" as const, optionId: "allow" } };
            })
            .connect(streamFromWebSocket(socket)),
        );
      });
    });
    const initialized = await client.agent.request(acp.methods.agent.initialize, {
      protocolVersion: acp.PROTOCOL_VERSION,
      clientCapabilities: {},
    });
    expect(initialized.agentCapabilities?.loadSession).toBe(true);
    return { socket, client, messages, permissions: () => permissions };
  };

  it("continues one conversation after consumer reconnect, bridge reconnect and bridge restart", async () => {
    const logs: string[] = [];
    const makeBridge = () => {
      const bridge = createBridgeAgentApp({
        dir: scratch,
        registrySlug: "codex-acp",
        authStatus: { state: "ok" },
        resolveDistribution: (slug) =>
          slug === "codex-acp" ? { command: process.execPath, args: [FIXTURE] } : null,
        log: (line) => logs.push(line),
      });
      bridges.push(bridge);
      return bridge;
    };
    const enrollment = await mintEnrollmentToken(db, {}, "http://localhost");
    const machine = await redeemEnrollmentToken(db, { token: enrollment.token, label: "recovery" });
    const bridge = makeBridge();
    let bridgeSocket = await connectBridge(machine.machineId, bridge);
    await waitUntil(async () =>
      (await listAgents(db)).some((a) => a.machineId === machine.machineId),
    );
    const agent = (await listAgents(db)).find((a) => a.machineId === machine.machineId);
    if (!agent) throw new Error("Agent was not registered");
    const credential = await mintConsumerApiKey(db, agent.id, "recovery", "http://localhost");
    let consumer = await connectConsumer(agent.id, credential.rawKey);
    const created = await consumer.client.agent.request(acp.methods.agent.session.new, {
      cwd: "/ignored-consumer-directory",
      mcpServers: [],
    });

    const prompt = async () => {
      expect(
        await consumer.client.agent.request(acp.methods.agent.session.prompt, {
          sessionId: created.sessionId,
          prompt: [{ type: "text", text: "reply PONG" }],
        }),
      ).toEqual({ stopReason: "end_turn" });
    };
    await prompt();
    expect(consumer.messages).toEqual(["PONG"]);
    expect(consumer.permissions()).toBe(1);

    for (const recovery of ["consumer", "bridge", "restart"] as const) {
      consumer.client.close();
      consumer.socket.terminate();
      if (recovery !== "consumer") {
        bridgeSocket.terminate();
        await waitUntil(() => getMachineBridge(machine.machineId) === undefined);
        if (recovery === "restart") {
          await bridge.disposeAllSessions();
          await flushSessionEvents(created.sessionId);
          (
            globalThis as typeof globalThis & {
              __acprouterSessionPersistence?: Map<string, unknown>;
            }
          ).__acprouterSessionPersistence?.clear();
        }
        bridgeSocket = await connectBridge(
          machine.machineId,
          recovery === "restart" ? makeBridge() : bridge,
        );
      }
      consumer = await connectConsumer(agent.id, credential.rawKey);
      await consumer.client.agent.request(acp.methods.agent.session.load, {
        sessionId: created.sessionId,
        cwd: "/ignored-on-recovery",
        mcpServers: [],
      });
      const turn = ["consumer", "bridge", "restart"].indexOf(recovery) + 1;
      // History has arrived before load resolves, without a new permission request.
      expect(consumer.messages).toEqual(Array(turn).fill("PONG"));
      expect(consumer.permissions()).toBe(0);
      await prompt();
      expect(consumer.messages).toEqual(Array(turn + 1).fill("PONG"));
      expect(consumer.permissions()).toBe(1);
    }
    await waitUntil(async () => {
      const history = await listSessionEvents(db, created.sessionId);
      return (
        history.filter(
          (event) =>
            event.type === "session_update" && event.update.sessionUpdate === "agent_message_chunk",
        ).length === 4
      );
    });
    expect(logs.filter((line) => line.includes("spawning "))).toHaveLength(2);
    expect(logs.filter((line) => line.includes("failed to relay"))).toEqual([]);
    const audit = readFileSync(path.join(scratch, ".fake-stdio-events.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { method: string });
    expect(audit.filter((event) => event.method === "session/new")).toHaveLength(1);
    expect(audit.filter((event) => event.method === "session/load")).toHaveLength(1);
    expect(audit.filter((event) => event.method === "session/prompt")).toHaveLength(4);
    expect(
      JSON.parse(readFileSync(path.join(scratch, ".fake-stdio-session.json"), "utf8")),
    ).toEqual({
      sessionId: created.sessionId,
      turns: 4,
    });
  });
});
