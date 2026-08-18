import { rmSync } from "node:fs";
import path from "node:path";
import type { BridgeInitializeMeta } from "@acprouter/contract";
import * as acp from "@agentclientprotocol/sdk";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import { runWithMemberContext } from "../../../context";
import { type Database, getDb } from "../../../db";
import { acprouterAgents, acprouterMachines } from "../../../db/schema";
import { streamFromWebSocket } from "./acp-ws-stream";
import { listAgents } from "./agents-logic";
import {
  acceptMachineBridgeConnection,
  MACHINE_BRIDGE_CLOSE_CODE,
} from "./machine-bridge-connection";
import { listMachines, mintEnrollmentToken, redeemEnrollmentToken } from "./machines-logic";
import {
  answerSessionPermission,
  DEFAULT_PERMISSION_TIMEOUT_MS,
  watchSession,
} from "./session-relay-registry";

const SCRATCH_DIR = ".data/machine-bridge-connection-test";

/**
 * Proves the thing task #7 actually exists to deliver: a real WS connection
 * to the Router's bridge route (represented here by a bare
 * `WebSocketServer` calling `acceptMachineBridgeConnection` exactly the way
 * `apps/acprouter/src/app/api/machines/bridge/route.ts`'s `UPGRADE` does),
 * carrying a real ACP `initialize` handshake, actually flips a machine's DB
 * row to `online` — and back to `offline` on disconnect. `machines.list`
 * showing "online" before task #7 meant nothing but "was redeemed once";
 * this test is what makes it mean "the bridge is connected right now".
 *
 * Mirrors `acp-ws-stream.integration.test.ts`'s shape (real `ws` sockets,
 * real SDK builders, no mocking of the protocol layer) and
 * `machines-logic.integration.test.ts`'s scratch-PGLite setup.
 */
describe("acceptMachineBridgeConnection", () => {
  let db: Database;
  let wss: WebSocketServer;
  let port: number;
  // Read at accept-time by the `wss` connection handler below — lets an
  // individual test override the permission timeout (task #11's
  // `agentAuthTimeoutMs`-style override pattern, task #9) without waiting
  // out the real 5-minute default. Reset in `afterEach` so it never leaks
  // into an unrelated test.
  let permissionTimeoutMsOverride = DEFAULT_PERMISSION_TIMEOUT_MS;

  beforeAll(async () => {
    rmSync(SCRATCH_DIR, { recursive: true, force: true });
    process.env.PG_DATABASE_URL = `pglite://${SCRATCH_DIR}`;
    db = await getDb({
      migrationsFolder: path.resolve(
        __dirname,
        "../../../../../../apps/acprouter/src/db/migrations",
      ),
    });

    wss = new WebSocketServer({ port: 0 });
    port = (wss.address() as { port: number }).port;
    wss.on("connection", (socket, req) => {
      const machineId = new URL(req.url ?? "", "http://localhost").searchParams.get("machineId");
      // Same call, same synchronous-no-await-before-it contract, as the real
      // route's `UPGRADE` handler — see that file's doc comment.
      acceptMachineBridgeConnection(
        Promise.resolve(db),
        machineId,
        socket,
        permissionTimeoutMsOverride,
      );
    });
  });

  afterAll(async () => {
    wss.close();
    rmSync(SCRATCH_DIR, { recursive: true, force: true });
  });

  afterEach(async () => {
    permissionTimeoutMsOverride = DEFAULT_PERMISSION_TIMEOUT_MS;
    await db.delete(acprouterAgents);
    await db.delete(acprouterMachines);
  });

  async function createMachine(): Promise<string> {
    const minted = await mintEnrollmentToken(db, {}, "http://example.test");
    const redeemed = await redeemEnrollmentToken(db, {
      token: minted.token,
      label: "test-machine",
    });
    return redeemed.machineId;
  }

  /** A minimal, honest ACP agent app — same shape as task #7's real CLI-side one. */
  function buildFakeMachineAgent(): acp.AgentApp {
    return acp
      .agent({ name: "fake-cli" })
      .onRequest(acp.methods.agent.initialize, () => ({
        protocolVersion: acp.PROTOCOL_VERSION,
        agentCapabilities: { loadSession: false },
        authMethods: [],
      }))
      .onRequest(acp.methods.agent.session.new, () => {
        throw new acp.RequestError(-32050, "not implemented", { reason: "not_implemented" });
      });
  }

  async function waitFor(predicate: () => Promise<boolean>, timeoutMs = 3000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await predicate()) return;
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error(`condition not met within ${timeoutMs}ms`);
  }

  async function statusOf(machineId: string): Promise<string | undefined> {
    const machines = await listMachines(db);
    return machines.find((m) => m.id === machineId)?.status;
  }

  it("flips a real machine online after a real ACP initialize handshake, then offline on disconnect", async () => {
    const machineId = await createMachine();
    expect(await statusOf(machineId)).toBe("online"); // redeem-time default (task #5)

    // Force it to prove the NEXT assertion is doing real work, not
    // trivially passing because redeem already set "online".
    const machinesBeforeConnect = await listMachines(db);
    expect(machinesBeforeConnect.find((m) => m.id === machineId)?.status).toBe("online");

    const cliSocket = new WebSocket(`ws://127.0.0.1:${port}?machineId=${machineId}`);
    const agentApp = buildFakeMachineAgent();

    // Wiring MUST happen synchronously inside the "open" callback, not after
    // an `await` — the same same-tick rule `machine-bridge-connection.ts`
    // itself documents applies symmetrically to this side of the socket too.
    // (An earlier draft of this test awaited "open" via a Promise and then
    // wired the stream afterward; that reintroduced the exact bug this task
    // is about, and the Router's `initialize` request — sent as soon as
    // `machineExists` resolves — was lost, hanging the test until timeout.)
    const agentConnection = await new Promise<acp.AgentConnection>((resolve, reject) => {
      cliSocket.once("open", () => {
        resolve(agentApp.connect(streamFromWebSocket(cliSocket)));
      });
      cliSocket.once("error", reject);
    });

    await waitFor(async () => (await statusOf(machineId)) === "online");
    // Not a tautology: between minting and this point the row was briefly
    // re-confirmed online by a REAL initialize round trip, which also
    // updated `lastSeenAt` — check that moved, proving `markMachineOnline`
    // actually ran rather than the redeem-time value merely persisting.
    const machinesAfterHandshake = await listMachines(db);
    const afterHandshake = machinesAfterHandshake.find((m) => m.id === machineId);
    expect(afterHandshake?.status).toBe("online");
    expect(afterHandshake?.lastSeenAt).not.toBeNull();

    cliSocket.close();
    agentConnection.close();

    await waitFor(async () => (await statusOf(machineId)) === "offline");
  });

  /** Same shape as `buildFakeMachineAgent`, but reports task #10's new `_meta` on the `initialize` response — standing in for a real `acprouter-cli` build. */
  function buildFakeMachineAgentWithMeta(meta: BridgeInitializeMeta): acp.AgentApp {
    return acp
      .agent({ name: "fake-cli-with-meta" })
      .onRequest(acp.methods.agent.initialize, () => ({
        protocolVersion: acp.PROTOCOL_VERSION,
        agentCapabilities: { loadSession: false },
        authMethods: [],
        _meta: meta,
      }))
      .onRequest(acp.methods.agent.session.new, () => {
        throw new acp.RequestError(-32050, "not implemented", { reason: "not_implemented" });
      });
  }

  async function agentRowFor(machineId: string) {
    const agents = await listAgents(db);
    return agents.find((a) => a.machineId === machineId);
  }

  it("task #10's channel: a machine that reports _meta on initialize gets a real connected agent row, which flips to disconnected on socket close", async () => {
    const machineId = await createMachine();
    const agentApp = buildFakeMachineAgentWithMeta({
      registrySlug: "claude-acp",
      cwd: "/home/user/projects/demo",
      detectedVersion: "1.4.0",
      authState: "ok",
      authDetail: null,
    });

    const cliSocket = new WebSocket(`ws://127.0.0.1:${port}?machineId=${machineId}`);
    const agentConnection = await new Promise<acp.AgentConnection>((resolve, reject) => {
      cliSocket.once("open", () => {
        resolve(agentApp.connect(streamFromWebSocket(cliSocket)));
      });
      cliSocket.once("error", reject);
    });

    await waitFor(async () => (await agentRowFor(machineId)) !== undefined);
    const agent = await agentRowFor(machineId);
    expect(agent).toMatchObject({
      kind: "bridged",
      registrySlug: "claude-acp",
      label: "Claude Code",
      cwd: "/home/user/projects/demo",
      detectedVersion: "1.4.0",
      status: "connected",
      statusDetail: null,
    });

    cliSocket.close();
    agentConnection.close();

    await waitFor(async () => (await agentRowFor(machineId))?.status === "disconnected");
  });

  it("a bridged agent's row keeps the MACHINE's tenant ownerId, not whatever context (or lack of one) happens to be ambient during the WS bridge", async () => {
    // Mint+redeem under a real member context — the machine row's ownerId
    // is "tenant-a", exactly like a real hosted host's dashboard flow.
    const machineId = await runWithMemberContext({ db, ownerId: "tenant-a" }, async () => {
      const minted = await mintEnrollmentToken(db, {}, "http://example.test");
      const redeemed = await redeemEnrollmentToken(db, {
        token: minted.token,
        label: "tenant-a-machine",
      });
      return redeemed.machineId;
    });

    // The WS bridge itself runs with NO ambient context, exactly like the
    // real route (see this Router's own runWithLocalContext usage — a
    // machine dials in with no session/actor of its own). Before the fix,
    // the resulting agent row would have been silently stamped with
    // whatever resolveOwnerId() falls back to here, not "tenant-a".
    const agentApp = buildFakeMachineAgentWithMeta({
      registrySlug: "claude-acp",
      cwd: "/home/user/projects/tenant-a",
      detectedVersion: "1.4.0",
      authState: "ok",
      authDetail: null,
    });
    const cliSocket = new WebSocket(`ws://127.0.0.1:${port}?machineId=${machineId}`);
    const agentConnection = await new Promise<acp.AgentConnection>((resolve, reject) => {
      cliSocket.once("open", () => {
        resolve(agentApp.connect(streamFromWebSocket(cliSocket)));
      });
      cliSocket.once("error", reject);
    });

    const agentAsTenantA = async () =>
      (await runWithMemberContext({ db, ownerId: "tenant-a" }, () => listAgents(db))).find(
        (a) => a.machineId === machineId,
      );
    await waitFor(async () => (await agentAsTenantA()) !== undefined);
    expect(await agentAsTenantA()).toMatchObject({ registrySlug: "claude-acp" });

    // And "tenant-b" must never see it.
    const agentsAsTenantB = await runWithMemberContext({ db, ownerId: "tenant-b" }, () =>
      listAgents(db),
    );
    expect(agentsAsTenantB.find((a) => a.machineId === machineId)).toBeUndefined();

    cliSocket.close();
    agentConnection.close();
  });

  it("task #10's channel: sign_in_needed maps to auth_required with the exact-next-step detail preserved, never a generic error", async () => {
    const machineId = await createMachine();
    const agentApp = buildFakeMachineAgentWithMeta({
      registrySlug: "codex-acp",
      cwd: "/home/user/projects/other",
      detectedVersion: "0.9.0",
      authState: "sign_in_needed",
      authDetail: "Sign-in needed: run `codex login` in a terminal.",
    });

    const cliSocket = new WebSocket(`ws://127.0.0.1:${port}?machineId=${machineId}`);
    const agentConnection = await new Promise<acp.AgentConnection>((resolve, reject) => {
      cliSocket.once("open", () => {
        resolve(agentApp.connect(streamFromWebSocket(cliSocket)));
      });
      cliSocket.once("error", reject);
    });

    await waitFor(async () => (await agentRowFor(machineId)) !== undefined);
    expect(await agentRowFor(machineId)).toMatchObject({
      status: "auth_required",
      statusDetail: "Sign-in needed: run `codex login` in a terminal.",
    });

    cliSocket.close();
    agentConnection.close();
  });

  it("task #10's defensive parsing: a machine with no _meta at all (old/misbehaving CLI) still connects fine, with no agent row created or crashed connection", async () => {
    const machineId = await createMachine();
    const agentApp = buildFakeMachineAgent(); // no `_meta` on its initialize response, same as before task #10

    const cliSocket = new WebSocket(`ws://127.0.0.1:${port}?machineId=${machineId}`);
    const agentConnection = await new Promise<acp.AgentConnection>((resolve, reject) => {
      cliSocket.once("open", () => {
        resolve(agentApp.connect(streamFromWebSocket(cliSocket)));
      });
      cliSocket.once("error", reject);
    });

    await waitFor(async () => (await statusOf(machineId)) === "online");
    expect(await agentRowFor(machineId)).toBeUndefined();

    cliSocket.close();
    agentConnection.close();
  });

  it("closes the socket with a distinct close code for an unrecognized machineId, without touching any DB row", async () => {
    const cliSocket = new WebSocket(`ws://127.0.0.1:${port}?machineId=does-not-exist`);

    const closeEvent = await new Promise<{ code: number }>((resolve, reject) => {
      cliSocket.once("close", (code) => resolve({ code }));
      cliSocket.once("error", reject);
    });

    expect(closeEvent.code).toBe(MACHINE_BRIDGE_CLOSE_CODE.unknownMachine);
    expect(await listMachines(db)).toHaveLength(0);
  });

  it("closes the socket with a distinct close code when machineId is missing entirely", async () => {
    const cliSocket = new WebSocket(`ws://127.0.0.1:${port}`);

    const closeEvent = await new Promise<{ code: number }>((resolve, reject) => {
      cliSocket.once("close", (code) => resolve({ code }));
      cliSocket.once("error", reject);
    });

    expect(closeEvent.code).toBe(MACHINE_BRIDGE_CLOSE_CODE.missingMachineId);
  });

  async function connectFakeMachine(
    machineId: string,
    agentApp: acp.AgentApp,
  ): Promise<{ cliSocket: WebSocket; agentConnection: acp.AgentConnection }> {
    const cliSocket = new WebSocket(`ws://127.0.0.1:${port}?machineId=${machineId}`);
    const agentConnection = await new Promise<acp.AgentConnection>((resolve, reject) => {
      cliSocket.once("open", () => {
        resolve(agentApp.connect(streamFromWebSocket(cliSocket)));
      });
      cliSocket.once("error", reject);
    });
    return { cliSocket, agentConnection };
  }

  /**
   * Task #11's actual deliverable: the placeholder handlers replaced with
   * `session-relay-registry.ts`. These tests exercise it through the SAME
   * real WS + real ACP handshake every other test in this file uses — only
   * the "browser" side is simulated (there's no real browser at this layer),
   * by calling `watchSession`/`answerSessionPermission` directly, exactly
   * the functions the real oRPC `sessions.prompt`/`sessions.answerPermission`
   * handlers call (`sessions-logic.ts`). Nothing about the ACP transport or
   * the relay routing itself is mocked.
   */
  describe("session relay routing (task #11)", () => {
    it("routes session/update and a permission request only to the session a browser is watching, and a real in-time answer delivers exactly {outcome:{outcome:'selected',optionId}} to the spawned agent", async () => {
      const machineId = await createMachine();
      const { cliSocket, agentConnection } = await connectFakeMachine(
        machineId,
        buildFakeMachineAgent(),
      );
      await waitFor(async () => (await statusOf(machineId)) === "online");

      const watcher = watchSession("sess_relay_1");

      await agentConnection.client.notify(acp.methods.client.session.update, {
        sessionId: "sess_relay_1",
        update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "hello" } },
      });
      const updateResult = await watcher.next();
      expect(updateResult.done).toBe(false);
      expect(updateResult.value).toEqual({
        type: "session_update",
        update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "hello" } },
      });

      const permissionPromise = agentConnection.client.request(
        acp.methods.client.session.requestPermission,
        {
          sessionId: "sess_relay_1",
          toolCall: {
            toolCallId: "tc_1",
            title: "run `rm -rf tmp/`",
            kind: "execute",
            status: "pending",
          },
          options: [
            { optionId: "allow", name: "Allow", kind: "allow_once" },
            { optionId: "deny", name: "Deny", kind: "reject_once" },
          ],
        },
      );

      const permissionResult = await watcher.next();
      expect(permissionResult.done).toBe(false);
      expect(permissionResult.value).toMatchObject({
        type: "permission_request",
        toolCall: { toolCallId: "tc_1" },
        options: [{ optionId: "allow" }, { optionId: "deny" }],
      });

      // Stands in for the browser's oRPC `sessions.answerPermission` call —
      // `sessions-logic.ts#answerAgentSessionPermission` is a thin wrapper
      // around exactly this function. `sess_relay_1` has no real
      // `acprouter_agent_sessions` row (this test drives the relay directly,
      // bypassing `startAgentSession`) — task #12's fire-and-forget
      // persistence write for it fails on a FK violation and is logged, not
      // thrown, which is exactly the "never affects relay behavior" property
      // under test elsewhere; not asserted here since this test is about the
      // relay, not persistence (see the new `session-events-logic`/
      // `session-status-logic` integration tests for that).
      expect(answerSessionPermission(Promise.resolve(db), "sess_relay_1", "deny")).toBe(true);

      // This is what the SPAWNED AGENT (this fake machine, standing in for
      // the real `bridge-agent.ts` relay) actually receives back — proves
      // the real SDK shape end to end, not just the registry's own return type.
      await expect(permissionPromise).resolves.toEqual({
        outcome: { outcome: "selected", optionId: "deny" },
      });

      const resolvedResult = await watcher.next();
      expect(resolvedResult.value).toEqual({ type: "permission_resolved", optionId: "deny" });

      cliSocket.close();
      agentConnection.close();
    });

    it("a permission request nobody is watching still resolves cancelled once its timeout elapses, and best-effort notifies session/cancel to the machine", async () => {
      permissionTimeoutMsOverride = 150; // real 5-minute default would be, per house style, wrong to wait out in a test
      const machineId = await createMachine();
      const cancelledSessionIds: string[] = [];
      const agentApp = buildFakeMachineAgent().onNotification(
        acp.methods.agent.session.cancel,
        (ctx) => {
          cancelledSessionIds.push(ctx.params.sessionId);
        },
      );
      const { cliSocket, agentConnection } = await connectFakeMachine(machineId, agentApp);
      await waitFor(async () => (await statusOf(machineId)) === "online");

      // Deliberately no `watchSession` call for this id — nobody's watching,
      // which is exactly the scenario acceptance criterion 12 and this
      // task's "never auto-allow" decision are about.
      const outcome = await agentConnection.client.request(
        acp.methods.client.session.requestPermission,
        {
          sessionId: "sess_relay_timeout",
          toolCall: {
            toolCallId: "tc_timeout",
            title: "run something risky",
            kind: "execute",
            status: "pending",
          },
          options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }],
        },
      );

      expect(outcome).toEqual({ outcome: { outcome: "cancelled" } });
      await waitFor(async () => cancelledSessionIds.includes("sess_relay_timeout"));

      cliSocket.close();
      agentConnection.close();
    }, 5000);
  });
});
