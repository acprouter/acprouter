import { rmSync } from "node:fs";
import path from "node:path";
import type { BridgeInitializeMeta } from "@acprouter/contract";
import * as acp from "@agentclientprotocol/sdk";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import { runWithMemberContext } from "../../../context";
import { type Database, getDb } from "../../../db";
import {
  acprouterAgentSessionEvents,
  acprouterAgentSessions,
  acprouterAgents,
  acprouterMachines,
} from "../../../db/schema";
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
import { promptAgentSession, startAgentSession } from "./sessions-logic";

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
    // Child-first: the attachment tests below run a real `session/new`, so
    // there are real session (and event) rows holding foreign keys into the
    // agents this then deletes.
    await db.delete(acprouterAgentSessionEvents);
    await db.delete(acprouterAgentSessions);
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
  let sessionSeq = 0;

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

    /**
     * What a user attaching a PDF actually produces on the wire.
     *
     * Everything below this point is real: a real `ws` socket, the real
     * `session/prompt` request built by `buildPromptContent` and serialized
     * by the real ACP SDK, received by a real `acp.agent()` implementation.
     * Unit tests pin what `buildPromptContent` RETURNS; only this pins what
     * an agent actually RECEIVES — which is where an unserialisable field, a
     * rejected `attachment:///` URI, or a schema that quietly drops
     * `filename` would show up instead.
     */
    /**
     * `promptCapabilities` is reported the way a REAL bridge reports it: on
     * the `session/new` response `_meta`, not the `initialize` one.
     *
     * That distinction is the whole point. A bridged machine does not spawn
     * its agent until `session/new` — the `initialize` handshake happens
     * before any agent exists, and advertises only what the CLI itself
     * implements. So the capabilities of the agent a session is actually
     * talking to can only ride back on that session's own response.
     *
     * Pass `null` to stand in for a CLI built before this channel existed:
     * it reports nothing, and the Router must fall back to sending
     * everything rather than withholding attachments it has no basis to
     * withhold.
     */
    async function connectRecordingAgent(promptCapabilities: acp.PromptCapabilities | null) {
      const machineId = await createMachine();
      const received: acp.ContentBlock[][] = [];
      const agentApp = acp
        .agent({ name: "recording-cli" })
        .onRequest(acp.methods.agent.initialize, () => ({
          protocolVersion: acp.PROTOCOL_VERSION,
          // Deliberately NOT the inner agent's capabilities — a real bridge
          // reports only its own here, which is exactly why the Router cannot
          // learn them from this handshake.
          agentCapabilities: { loadSession: false },
          authMethods: [],
          // Without `_meta` the bridge creates no agent row at all (task #10),
          // and there would be nothing for `promptAgentSession` to resolve.
          _meta: {
            registrySlug: "claude-acp",
            cwd: "/home/user/projects/demo",
            detectedVersion: "1.4.0",
            authState: "ok",
            authDetail: null,
          } satisfies BridgeInitializeMeta,
        }))
        .onRequest(acp.methods.agent.session.new, () => ({
          // Unique across the whole FILE, not just this agent: the
          // capability registry is keyed by session id and lives for the
          // process, so a per-call counter would hand two tests the same id
          // and leak the first one's capabilities into the second.
          sessionId: `sess_attach_${++sessionSeq}`,
          ...(promptCapabilities ? { _meta: { promptCapabilities } } : {}),
        }))
        .onRequest(acp.methods.agent.session.prompt, (ctx) => {
          received.push(ctx.params.prompt);
          return { stopReason: "end_turn" as const };
        });
      const { cliSocket, agentConnection } = await connectFakeMachine(machineId, agentApp);
      await waitFor(async () => (await agentRowFor(machineId)) !== undefined);
      const agent = await agentRowFor(machineId);
      if (!agent) throw new Error("no agent row for the connected machine");
      // The real `session/new` round trip — this is what populates the
      // per-session capability registry `promptAgentSession` reads.
      const { sessionId } = await startAgentSession(db, agent.id);
      return { agentId: agent.id, sessionId, received, cliSocket, agentConnection };
    }

    async function drain(generator: AsyncGenerator<unknown>) {
      const out: unknown[] = [];
      for await (const event of generator) out.push(event);
      return out;
    }

    it("delivers an attached PDF to a real agent as an ACP blob resource, filename and all", async () => {
      const { agentId, sessionId, received, cliSocket, agentConnection } =
        await connectRecordingAgent({
          embeddedContext: true,
        });
      // A real PDF header, including a NUL byte — the thing that must NOT be
      // mistaken for text and must survive base64 round-tripping intact.
      const pdf = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37, 0x00, 0xff]);

      await drain(
        promptAgentSession(db, {
          agentId,
          sessionId,
          text: "summarise this",
          attachments: [
            {
              kind: "file",
              data: pdf.toString("base64"),
              mimeType: "application/pdf",
              filename: "q3 report.pdf",
            },
          ],
        }),
      );

      expect(received).toHaveLength(1);
      expect(received[0]).toEqual([
        { type: "text", text: "summarise this" },
        {
          type: "resource",
          resource: {
            uri: "attachment:///q3%20report.pdf",
            mimeType: "application/pdf",
            blob: pdf.toString("base64"),
          },
        },
      ]);
      // The bytes the agent could decode are the bytes the user attached.
      const block = received[0]?.[1] as { resource: { blob: string } };
      expect(Buffer.from(block.resource.blob, "base64").equals(pdf)).toBe(true);

      cliSocket.close();
      agentConnection.close();
    });

    it("delivers an attached Markdown file as readable ACP text, not base64 the agent must decode", async () => {
      const { agentId, sessionId, received, cliSocket, agentConnection } =
        await connectRecordingAgent({
          embeddedContext: true,
        });

      await drain(
        promptAgentSession(db, {
          agentId,
          sessionId,
          text: "",
          attachments: [
            {
              kind: "file",
              data: Buffer.from("# 报告\n\nrevenue up", "utf8").toString("base64"),
              mimeType: "text/markdown",
              filename: "notes.md",
            },
          ],
        }),
      );

      expect(received[0]?.[1]).toEqual({
        type: "resource",
        resource: {
          uri: "attachment:///notes.md",
          mimeType: "text/markdown",
          // Multi-byte CJK survives the base64 → UTF-8 decode.
          text: "# 报告\n\nrevenue up",
        },
      });

      cliSocket.close();
      agentConnection.close();
    });

    it("falls back to inlined text, and says so, for an agent that advertises no embeddedContext", async () => {
      const { agentId, sessionId, received, cliSocket, agentConnection } =
        await connectRecordingAgent({});

      const events = await drain(
        promptAgentSession(db, {
          agentId,
          sessionId,
          text: "summarise",
          attachments: [
            {
              kind: "file",
              data: Buffer.from("a,b\n1,2", "utf8").toString("base64"),
              mimeType: "text/csv",
              filename: "data.csv",
            },
          ],
        }),
      );

      // One text block only — no `resource` block reached an agent that never
      // said it could take one, which is the ACP compliance point.
      expect(received[0]).toEqual([
        {
          type: "text",
          text: "summarise\n\n--- Attached file: data.csv ---\na,b\n1,2\n--- End of attached file: data.csv ---",
        },
      ]);
      // …and the user is told what happened rather than left guessing.
      expect(events).toContainEqual({
        type: "note",
        text: "This agent does not accept file attachments, so data.csv was included as plain text instead.",
      });

      cliSocket.close();
      agentConnection.close();
    });

    it("drops a binary attachment such an agent cannot take, and explains why", async () => {
      const { agentId, sessionId, received, cliSocket, agentConnection } =
        await connectRecordingAgent({});

      const events = await drain(
        promptAgentSession(db, {
          agentId,
          sessionId,
          text: "read it",
          attachments: [
            {
              kind: "file",
              data: Buffer.from([0x25, 0x50, 0x44, 0x46, 0x00]).toString("base64"),
              mimeType: "application/pdf",
              filename: "report.pdf",
            },
          ],
        }),
      );

      expect(received[0]).toEqual([{ type: "text", text: "read it" }]);
      expect(events).toContainEqual({
        type: "note",
        text: "This agent does not accept file attachments, and report.pdf is not text, so it was not sent.",
      });

      cliSocket.close();
      agentConnection.close();
    });

    it("withholds an image from an agent that never advertised the image capability", async () => {
      const { agentId, sessionId, received, cliSocket, agentConnection } =
        await connectRecordingAgent({
          embeddedContext: true,
        });

      const events = await drain(
        promptAgentSession(db, {
          agentId,
          sessionId,
          text: "look",
          attachments: [{ kind: "image", data: "aW1n", mimeType: "image/png" }],
        }),
      );

      expect(received[0]).toEqual([{ type: "text", text: "look" }]);
      expect(events).toContainEqual({
        type: "note",
        text: "This agent does not accept image attachments, so it was not sent.",
      });

      cliSocket.close();
      agentConnection.close();
    });

    it("sends everything to a CLI too old to report capabilities, rather than withholding on a guess", async () => {
      // `null` = the bridge's `session/new` carries no `_meta` at all, which
      // is every acprouter-cli built before that channel existed. Withholding
      // attachments here would BREAK those users; the honest reading of "no
      // answer" is "not negotiated", not "supports nothing".
      const { agentId, sessionId, received, cliSocket, agentConnection } =
        await connectRecordingAgent(null);

      const events = await drain(
        promptAgentSession(db, {
          agentId,
          sessionId,
          text: "look",
          attachments: [
            { kind: "image", data: "aW1n", mimeType: "image/png" },
            {
              kind: "file",
              data: Buffer.from("hi", "utf8").toString("base64"),
              mimeType: "text/plain",
              filename: "n.txt",
            },
          ],
        }),
      );

      expect(received[0]?.map((block) => block.type)).toEqual(["text", "image", "resource"]);
      expect(events.filter((e) => (e as { type: string }).type === "note")).toEqual([]);

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
