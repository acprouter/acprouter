import { rmSync } from "node:fs";
import path from "node:path";
import type { BridgeInitializeMeta } from "@acprouter/contract";
import * as acp from "@agentclientprotocol/sdk";
import { eq } from "drizzle-orm";
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
import { listAgents, removeAgent } from "./agents-logic";
import { acceptMachineBridgeConnection } from "./machine-bridge-connection";
import { listMachines, mintEnrollmentToken, redeemEnrollmentToken } from "./machines-logic";
import { getSessionCapabilities } from "./session-capabilities-registry";
import { listSessionEvents } from "./session-events-logic";
import { insertActiveSession } from "./session-status-logic";
import {
  answerAgentSessionPermission,
  endAgentSession,
  promptAgentSession,
  startAgentSession,
} from "./sessions-logic";

const SCRATCH_DIR = ".data/sessions-logic-test";

/**
 * Real PGLite + real WS + real ACP handshake — task #12's actual deliverable
 * end to end: `startAgentSession`/`promptAgentSession` (task #11's real
 * functions, unmodified in their browser-facing behavior) now durably
 * persist a real turn's events in the right `seq` order AND transition
 * `acprouter_agent_sessions.status` correctly, without the browser's stream
 * (the generator's own yielded events) differing at all from before this
 * task. Mirrors `machine-bridge-connection.integration.test.ts`'s WS setup.
 */
describe("sessions-logic persistence (task #12)", () => {
  let db: Database;
  let wss: WebSocketServer;
  let port: number;

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
      acceptMachineBridgeConnection(Promise.resolve(db), machineId, socket);
    });
  });

  afterAll(async () => {
    wss.close();
    rmSync(SCRATCH_DIR, { recursive: true, force: true });
  });

  afterEach(async () => {
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

  async function waitFor(predicate: () => Promise<boolean>, timeoutMs = 3000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await predicate()) return;
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error(`condition not met within ${timeoutMs}ms`);
  }

  /** A fake CLI-side agent that actually answers `session/new` and `session/prompt` for real, streaming one real `session/update` before resolving — standing in for `bridge-agent.ts` (task #8) the same way `machine-bridge-connection.integration.test.ts`'s fakes do. */
  function buildFakeCli(
    meta: BridgeInitializeMeta,
    opts?: { onSessionNew?: () => Promise<void> },
  ): acp.AgentApp {
    let nextSessionId = 0;
    return acp
      .agent({ name: "fake-cli" })
      .onRequest(acp.methods.agent.initialize, () => ({
        protocolVersion: acp.PROTOCOL_VERSION,
        agentCapabilities: { loadSession: false },
        authMethods: [],
        _meta: meta,
      }))
      .onRequest(acp.methods.agent.session.new, async () => {
        await opts?.onSessionNew?.();
        nextSessionId += 1;
        return { sessionId: `sess_fake_${nextSessionId}` };
      })
      .onRequest(acp.methods.agent.session.prompt, async (ctx) => {
        await ctx.client.notify(acp.methods.client.session.update, {
          sessionId: ctx.params.sessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "pong" },
          },
        });
        return { stopReason: "end_turn" };
      });
  }

  async function connectFakeMachine(machineId: string, agentApp: acp.AgentApp) {
    const cliSocket = new WebSocket(`ws://127.0.0.1:${port}?machineId=${machineId}`);
    const agentConnection = await new Promise<acp.AgentConnection>((resolve, reject) => {
      cliSocket.once("open", () => {
        resolve(agentApp.connect(streamFromWebSocket(cliSocket)));
      });
      cliSocket.once("error", reject);
    });
    return { cliSocket, agentConnection };
  }

  async function statusOf(sessionId: string): Promise<string | undefined> {
    const [row] = await db
      .select({ status: acprouterAgentSessions.status })
      .from(acprouterAgentSessions)
      .where(eq(acprouterAgentSessions.id, sessionId));
    return row?.status;
  }

  it("a real prompt turn persists its events in seq order, transitions active -> idle, and history read-back matches exactly what the browser's generator yielded", async () => {
    const machineId = await createMachine();
    const { cliSocket, agentConnection } = await connectFakeMachine(
      machineId,
      buildFakeCli({
        registrySlug: "claude-acp",
        cwd: "/home/user/projects/demo",
        detectedVersion: "1.4.0",
        authState: "ok",
        authDetail: null,
      }),
    );

    await waitFor(
      async () => (await listMachines(db)).find((m) => m.id === machineId)?.status === "online",
    );
    let agentId: string | undefined;
    await waitFor(async () => {
      agentId = (await listAgents(db)).find((a) => a.machineId === machineId)?.id;
      return agentId !== undefined;
    });
    if (!agentId) throw new Error("agent row never appeared");

    const { sessionId } = await startAgentSession(db, agentId);
    expect(await statusOf(sessionId)).toBe("active");

    const seenByBrowser: unknown[] = [];
    for await (const event of promptAgentSession(db, { agentId, sessionId, text: "ping" })) {
      seenByBrowser.push(event);
    }

    expect(seenByBrowser).toEqual([
      {
        type: "session_update",
        update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "pong" } },
      },
      { type: "turn_ended", stopReason: "end_turn" },
    ]);

    await waitFor(async () => (await statusOf(sessionId)) === "idle");

    // Persistence is fire-and-forget relative to the generator's `yield`s
    // (by design — see `persistEvent`'s doc comment), so the row may land a
    // tick after the browser already saw the event. Poll rather than assert
    // immediately.
    await waitFor(async () => (await listSessionEvents(db, sessionId)).length === 2);
    const persisted = await listSessionEvents(db, sessionId);
    expect(persisted).toEqual(seenByBrowser);

    const rows = await db
      .select({ seq: acprouterAgentSessionEvents.seq })
      .from(acprouterAgentSessionEvents)
      .where(eq(acprouterAgentSessionEvents.sessionId, sessionId));
    expect(rows.map((r) => r.seq).sort((a, b) => a - b)).toEqual([1, 2]);

    cliSocket.close();
    agentConnection.close();
  });

  it("removeAgent committing in the window between session/new's response and startAgentSession's own locked insert still ends up with no live session row and no leaked capabilities entry", async () => {
    const machineId = await createMachine();
    let agentId: string | undefined;
    const { cliSocket, agentConnection } = await connectFakeMachine(
      machineId,
      buildFakeCli(
        {
          registrySlug: "claude-acp",
          cwd: "/home/user/projects/race",
          detectedVersion: "1.4.0",
          authState: "ok",
          authDetail: null,
        },
        {
          // Simulates `removeAgent` running for real in the window between
          // `session/new`'s response landing (capabilities already
          // remembered, `onSessionCreated` already fired) and
          // `startAgentSession`'s own `FOR UPDATE`-locked re-check +
          // insert transaction. Going through the real `removeAgent` here
          // (not a raw `UPDATE`) is what the earlier version of this test
          // skipped — it only pinned the pre-insert window with a direct
          // column write, which never exercised `removeAgent`'s own
          // session-ending sweep or proved anything about the registries
          // `startAgentSession` populates before this hook even runs.
          // `status` must be `disconnected` first — `removeAgent` only
          // soft-deletes a row in that state.
          onSessionNew: async () => {
            if (!agentId) throw new Error("agentId not resolved before session/new");
            await db
              .update(acprouterAgents)
              .set({ status: "disconnected" })
              .where(eq(acprouterAgents.id, agentId));
            const result = await removeAgent(db, agentId);
            expect(result.ok).toBe(true);
          },
        },
      ),
    );

    await waitFor(
      async () => (await listMachines(db)).find((m) => m.id === machineId)?.status === "online",
    );
    await waitFor(async () => {
      agentId = (await listAgents(db)).find((a) => a.machineId === machineId)?.id;
      return agentId !== undefined;
    });
    if (!agentId) throw new Error("agent row never appeared");

    await expect(startAgentSession(db, agentId)).rejects.toThrow(/No agent registered with id/);

    const sessionRows = await db
      .select()
      .from(acprouterAgentSessions)
      .where(eq(acprouterAgentSessions.agentId, agentId));
    expect(sessionRows).toHaveLength(0);

    // The capabilities `rememberSessionCapabilities` stored right after
    // `session/new` returned (before this race was even detectable) must
    // not linger forever just because the session itself never got a
    // persisted row — `startAgentSession`'s own NOT_FOUND path forgets it.
    expect(getSessionCapabilities("sess_fake_1")).toBeNull();

    cliSocket.close();
    agentConnection.close();
  });

  it("startAgentSession winning the race against a concurrent removeAgent still leaves removeAgent's own sweep able to end the session it could not have seen yet", async () => {
    const machineId = await createMachine();
    let agentId: string | undefined;
    let sawSessionRowDuringRemoval: boolean | undefined;
    const { cliSocket, agentConnection } = await connectFakeMachine(
      machineId,
      buildFakeCli(
        {
          registrySlug: "claude-acp",
          cwd: "/home/user/projects/race-win",
          detectedVersion: "1.4.0",
          authState: "ok",
          authDetail: null,
        },
        {
          // The opposite ordering from the test above: `removeAgent` is
          // invoked from inside `session/new`'s handler too, but by the
          // time it runs here `startAgentSession`'s locked transaction
          // hasn't opened yet either — PGLite's single connection means
          // these never truly interleave (see the comment on
          // `agents-logic.integration.test.ts`'s own back-to-back race
          // test), so this proves the OTHER half of the same contract: even
          // when `startAgentSession` is the one that ends up committing its
          // insert first, `removeAgent`'s unconditional "end every live,
          // non-terminal session row for this agent" sweep still reaches a
          // row that did not exist when THIS line ran, because the two
          // transactions serialize on the agent row's `FOR UPDATE` lock —
          // `removeAgent` cannot have committed before `startAgentSession`'s
          // own transaction opens if `startAgentSession` is the one that
          // observably won.
          onSessionNew: async () => {
            if (!agentId) throw new Error("agentId not resolved before session/new");
            const rows = await db
              .select()
              .from(acprouterAgentSessions)
              .where(eq(acprouterAgentSessions.agentId, agentId));
            sawSessionRowDuringRemoval = rows.length > 0;
          },
        },
      ),
    );

    await waitFor(
      async () => (await listMachines(db)).find((m) => m.id === machineId)?.status === "online",
    );
    await waitFor(async () => {
      agentId = (await listAgents(db)).find((a) => a.machineId === machineId)?.id;
      return agentId !== undefined;
    });
    if (!agentId) throw new Error("agent row never appeared");

    const { sessionId } = await startAgentSession(db, agentId);
    expect(sawSessionRowDuringRemoval).toBe(false);
    expect(await statusOf(sessionId)).toBe("active");

    // Now run the removal for real, strictly AFTER the insert committed —
    // its sweep must still find and end this exact row.
    await db
      .update(acprouterAgents)
      .set({ status: "disconnected" })
      .where(eq(acprouterAgents.id, agentId));
    const result = await removeAgent(db, agentId);
    expect(result.ok).toBe(true);
    expect(await statusOf(sessionId)).toBe("ended");

    cliSocket.close();
    agentConnection.close();
  });

  it("endAgentSession marks the session row ended", async () => {
    const machineId = await createMachine();
    const { cliSocket, agentConnection } = await connectFakeMachine(
      machineId,
      buildFakeCli({
        registrySlug: "codex-acp",
        cwd: "/home/user/projects/other",
        detectedVersion: "0.9.0",
        authState: "ok",
        authDetail: null,
      }),
    );

    await waitFor(
      async () => (await listMachines(db)).find((m) => m.id === machineId)?.status === "online",
    );
    let agentId: string | undefined;
    await waitFor(async () => {
      agentId = (await listAgents(db)).find((a) => a.machineId === machineId)?.id;
      return agentId !== undefined;
    });
    if (!agentId) throw new Error("agent row never appeared");

    const { sessionId } = await startAgentSession(db, agentId);
    expect(await statusOf(sessionId)).toBe("active");

    const result = await endAgentSession(db, { agentId, sessionId });
    expect(result.ok).toBe(true);
    await waitFor(async () => (await statusOf(sessionId)) === "ended");

    cliSocket.close();
    agentConnection.close();
  });

  describe("answerAgentSessionPermission tenant scoping", () => {
    /**
     * Regression coverage for the gap flagged directly against this
     * function: `answerAgentSessionPermission(db, sessionId, optionId)` used
     * to take only a bare `sessionId` — no ownership check at all — and
     * `session-relay-registry.ts`'s `answerSessionPermission` it calls into
     * is a purely in-memory lookup with no db/ownerId concept of its own. So
     * tenant B could answer (or spuriously resolve) tenant A's pending
     * permission prompt just by knowing (or guessing) tenant A's live
     * `sessionId`. A real pending permission isn't needed to prove the fix —
     * the ownership check now runs BEFORE the relay is ever touched, so a
     * cross-tenant call must be rejected regardless of whether anything is
     * actually pending.
     */
    async function createAgentAndSessionForOwner(ownerId: string): Promise<string> {
      const agentId = `agt_perm_test_${ownerId}_${Date.now()}_${Math.random().toString(36).slice(2)}`;
      await db.insert(acprouterAgents).values({
        id: agentId,
        ownerId,
        machineId: null,
        kind: "remote-acp",
        label: "Test Agent",
        status: "connected",
      });
      const sessionId = `sess_${agentId}`;
      await insertActiveSession(db, { id: sessionId, agentId, consumerId: null });
      return sessionId;
    }

    it("a different tenant cannot answer another tenant's session permission — rejects NOT_FOUND", async () => {
      const sessionId = await createAgentAndSessionForOwner("tenant-a");

      await expect(
        runWithMemberContext({ db, ownerId: "tenant-b" }, () =>
          answerAgentSessionPermission(db, sessionId, "opt_allow"),
        ),
      ).rejects.toMatchObject({ code: "NOT_FOUND" });
    });

    it("the owning tenant's call passes the ownership check and reaches the relay (no false-positive lockout)", async () => {
      const sessionId = await createAgentAndSessionForOwner("tenant-a");

      // No permission is actually pending, so `answered` is `false` — the
      // point of this assertion is that the call resolves at all (reaches
      // `session-relay-registry.ts`) instead of throwing NOT_FOUND for a
      // caller who really does own this session.
      const result = await runWithMemberContext({ db, ownerId: "tenant-a" }, () =>
        answerAgentSessionPermission(db, sessionId, "opt_allow"),
      );
      expect(result).toEqual({ answered: false });
    });

    it("an unrecognized sessionId rejects NOT_FOUND regardless of the caller's tenant", async () => {
      await expect(
        runWithMemberContext({ db, ownerId: "tenant-a" }, () =>
          answerAgentSessionPermission(db, "sess_does_not_exist", "opt_allow"),
        ),
      ).rejects.toMatchObject({ code: "NOT_FOUND" });
    });
  });
});
