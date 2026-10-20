import { rmSync } from "node:fs";
import path from "node:path";
import { ORPCError } from "@orpc/server";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { type Database, getDb } from "../../../db";
import {
  acprouterAgentSessions,
  acprouterAgents,
  acprouterConsumerApiKeys,
  acprouterEnrollmentTokens,
  acprouterMachines,
  acprouterUsageRecords,
} from "../../../db/schema";
import {
  getAgentById,
  getAgentByMachineId,
  listAgents,
  markAgentsDisconnected,
  removeAgent,
  upsertBridgedAgent,
} from "./agents-logic";
import { mintConsumerApiKey, validateConsumerApiKey } from "./consumer-api-keys-logic";
import { hashToken, mintEnrollmentToken, redeemEnrollmentToken } from "./machines-logic";
import {
  getRemoteSessionConnection,
  registerRemoteSessionConnection,
} from "./remote-session-registry";
import { insertActiveSession } from "./session-status-logic";

const SCRATCH_DIR = ".data/agents-logic-test";
const OWNER_ID = "local";

describe("agents-logic", () => {
  let db: Database;

  beforeAll(async () => {
    rmSync(SCRATCH_DIR, { recursive: true, force: true });
    process.env.PG_DATABASE_URL = `pglite://${SCRATCH_DIR}`;
    db = await getDb({
      migrationsFolder: path.resolve(
        __dirname,
        "../../../../../../apps/acprouter/src/db/migrations",
      ),
    });
  });

  afterAll(() => {
    rmSync(SCRATCH_DIR, { recursive: true, force: true });
  });

  beforeEach(async () => {
    await db.delete(acprouterUsageRecords);
    await db.delete(acprouterConsumerApiKeys);
    await db.delete(acprouterAgentSessions);
    await db.delete(acprouterAgents);
    await db.delete(acprouterMachines);
    await db.delete(acprouterEnrollmentTokens);
  });

  async function createMachine(label = "test-machine"): Promise<string> {
    const minted = await mintEnrollmentToken(db, {}, "http://example.test");
    const redeemed = await redeemEnrollmentToken(db, { token: minted.token, label });
    return redeemed.machineId;
  }

  it("upsertBridgedAgent inserts a new row for a fresh (machineId, registrySlug) pair", async () => {
    const machineId = await createMachine();

    await upsertBridgedAgent(db, {
      ownerId: OWNER_ID,
      machineId,
      registrySlug: "claude-acp",
      label: "Claude Code",
      cwd: "/home/user/projects/foo",
      detectedVersion: "1.2.3",
      status: "connected",
    });

    const agents = await listAgents(db);
    expect(agents).toHaveLength(1);
    expect(agents[0]).toMatchObject({
      kind: "bridged",
      registrySlug: "claude-acp",
      label: "Claude Code",
      machineId,
      cwd: "/home/user/projects/foo",
      detectedVersion: "1.2.3",
      status: "connected",
      statusDetail: null,
    });
  });

  it("upsertBridgedAgent updates the SAME row on a second call for the same (machineId, registrySlug) pair, not a duplicate", async () => {
    const machineId = await createMachine();

    await upsertBridgedAgent(db, {
      ownerId: OWNER_ID,
      machineId,
      registrySlug: "claude-acp",
      label: "Claude Code",
      cwd: "/old/dir",
      detectedVersion: "1.0.0",
      status: "connected",
    });
    const [firstRow] = await listAgents(db);

    await upsertBridgedAgent(db, {
      ownerId: OWNER_ID,
      machineId,
      registrySlug: "claude-acp",
      label: "Claude Code",
      cwd: "/new/dir",
      detectedVersion: "1.1.0",
      status: "connected",
    });

    const agents = await listAgents(db);
    expect(agents).toHaveLength(1);
    expect(agents[0].id).toBe(firstRow.id);
    expect(agents[0].cwd).toBe("/new/dir");
    expect(agents[0].detectedVersion).toBe("1.1.0");
  });

  it("upsertBridgedAgent keeps distinct rows for two different machines bridging the same registrySlug", async () => {
    const machineA = await createMachine("laptop-a");
    const machineB = await createMachine("laptop-b");

    await upsertBridgedAgent(db, {
      ownerId: OWNER_ID,
      machineId: machineA,
      registrySlug: "claude-acp",
      label: "Claude Code",
      cwd: "/a",
      detectedVersion: null,
      status: "connected",
    });
    await upsertBridgedAgent(db, {
      ownerId: OWNER_ID,
      machineId: machineB,
      registrySlug: "claude-acp",
      label: "Claude Code",
      cwd: "/b",
      detectedVersion: null,
      status: "connected",
    });

    const agents = await listAgents(db);
    expect(agents).toHaveLength(2);
    expect(new Set(agents.map((a) => a.machineId))).toEqual(new Set([machineA, machineB]));
  });

  it("markAgentsDisconnected flips every agent row for a machine to disconnected, and does not touch other machines' rows", async () => {
    const machineA = await createMachine("laptop-a");
    const machineB = await createMachine("laptop-b");

    await upsertBridgedAgent(db, {
      ownerId: OWNER_ID,
      machineId: machineA,
      registrySlug: "claude-acp",
      label: "Claude Code",
      cwd: "/a",
      detectedVersion: "1.0.0",
      status: "connected",
    });
    await upsertBridgedAgent(db, {
      ownerId: OWNER_ID,
      machineId: machineB,
      registrySlug: "codex-acp",
      label: "Codex",
      cwd: "/b",
      detectedVersion: "2.0.0",
      status: "connected",
    });

    await markAgentsDisconnected(db, machineA);

    const agents = await listAgents(db);
    const agentA = agents.find((a) => a.machineId === machineA);
    const agentB = agents.find((a) => a.machineId === machineB);
    expect(agentA?.status).toBe("disconnected");
    expect(agentB?.status).toBe("connected");
  });

  it("markAgentsDisconnected on a machine with no agent rows is a no-op, not an error", async () => {
    const machineId = await createMachine();
    await expect(markAgentsDisconnected(db, machineId)).resolves.toBeUndefined();
    expect(await listAgents(db)).toHaveLength(0);
  });

  it("stores and round-trips the auth_required status with its statusDetail (acceptance criterion 10's exact-next-step string)", async () => {
    const machineId = await createMachine();

    await upsertBridgedAgent(db, {
      ownerId: OWNER_ID,
      machineId,
      registrySlug: "claude-acp",
      label: "Claude Code",
      cwd: "/home/user/projects/foo",
      detectedVersion: "1.2.3",
      status: "auth_required",
      statusDetail: "Sign-in needed: run `claude` in a terminal and finish the browser login.",
    });

    const [agent] = await listAgents(db);
    expect(agent.status).toBe("auth_required");
    expect(agent.statusDetail).toBe(
      "Sign-in needed: run `claude` in a terminal and finish the browser login.",
    );
  });

  it("stores and round-trips the error status with its statusDetail, distinct from auth_required", async () => {
    const machineId = await createMachine();

    await upsertBridgedAgent(db, {
      ownerId: OWNER_ID,
      machineId,
      registrySlug: "claude-acp",
      label: "Claude Code",
      cwd: "/home/user/projects/foo",
      detectedVersion: "1.2.3",
      status: "error",
      statusDetail: "Could not check sign-in status: probe timed out.",
    });

    const [agent] = await listAgents(db);
    expect(agent.status).toBe("error");
    expect(agent.statusDetail).toBe("Could not check sign-in status: probe timed out.");
  });

  it("listAgents only returns rows for the given owner (LOCAL_OWNER_ID scoping, same pattern as listMachines)", async () => {
    const machineId = await createMachine();
    await upsertBridgedAgent(db, {
      ownerId: OWNER_ID,
      machineId,
      registrySlug: "claude-acp",
      label: "Claude Code",
      cwd: "/home/user",
      detectedVersion: null,
      status: "connected",
    });
    // A row under a different owner (can't happen yet in the OSS single-owner
    // edition, but the query itself must not silently ignore the filter).
    await db.insert(acprouterAgents).values({
      id: "agt_other_owner",
      ownerId: "someone-else",
      machineId: null,
      kind: "remote-acp",
      registrySlug: null,
      label: "Someone else's agent",
      status: "connected",
    });

    const agents = await listAgents(db);
    expect(agents.map((a) => a.id)).not.toContain("agt_other_owner");
  });

  it("upsertBridgedAgent's unique (machineId, registrySlug) index is what makes the upsert-not-duplicate behavior safe — asserted directly against the row count in the table, not just listAgents' output", async () => {
    const machineId = await createMachine();
    await upsertBridgedAgent(db, {
      ownerId: OWNER_ID,
      machineId,
      registrySlug: "claude-acp",
      label: "Claude Code",
      cwd: "/x",
      detectedVersion: null,
      status: "connected",
    });
    await upsertBridgedAgent(db, {
      ownerId: OWNER_ID,
      machineId,
      registrySlug: "claude-acp",
      label: "Claude Code",
      cwd: "/y",
      detectedVersion: null,
      status: "disconnected",
    });

    const rows = await db
      .select()
      .from(acprouterAgents)
      .where(eq(acprouterAgents.machineId, machineId));
    expect(rows).toHaveLength(1);
  });

  describe("removeAgent", () => {
    async function createBridgedAgent(
      status: "connected" | "disconnected" | "auth_required" | "error" = "disconnected",
      registrySlug = "claude-acp",
    ) {
      const machineId = await createMachine();
      await upsertBridgedAgent(db, {
        ownerId: OWNER_ID,
        machineId,
        registrySlug,
        label: "Claude Code",
        cwd: "/home/user/projects/foo",
        detectedVersion: "1.2.3",
        status,
      });
      const [agent] = await listAgents(db);
      return { machineId, agentId: agent.id, registrySlug };
    }

    it("removes a disconnected agent", async () => {
      const { agentId } = await createBridgedAgent("disconnected");
      const result = await removeAgent(db, agentId);
      expect(result).toEqual({ ok: true });
      expect(await listAgents(db)).toHaveLength(0);
    });

    it("rejects an auth_required agent, leaving the row unchanged", async () => {
      const { agentId } = await createBridgedAgent("auth_required");
      const result = await removeAgent(db, agentId);
      expect(result).toEqual({ ok: false });

      const [row] = await db.select().from(acprouterAgents).where(eq(acprouterAgents.id, agentId));
      expect(row?.status).toBe("auth_required");
      expect(row?.deletedAt).toBeNull();
    });

    it("rejects an error agent, leaving the row unchanged", async () => {
      const { agentId } = await createBridgedAgent("error");
      const result = await removeAgent(db, agentId);
      expect(result).toEqual({ ok: false });

      const [row] = await db.select().from(acprouterAgents).where(eq(acprouterAgents.id, agentId));
      expect(row?.status).toBe("error");
      expect(row?.deletedAt).toBeNull();
    });

    it("rejects a connected agent, leaving the row unchanged", async () => {
      const { agentId } = await createBridgedAgent("connected");
      const result = await removeAgent(db, agentId);
      expect(result).toEqual({ ok: false });

      const [row] = await db.select().from(acprouterAgents).where(eq(acprouterAgents.id, agentId));
      expect(row?.status).toBe("connected");
      expect(row?.deletedAt).toBeNull();
    });

    it("rejects a cross-tenant agent id as not-found, and leaves the other tenant's row unchanged", async () => {
      await db.insert(acprouterAgents).values({
        id: "agt_cross_tenant",
        ownerId: "someone-else",
        machineId: null,
        kind: "remote-acp",
        registrySlug: null,
        label: "Someone else's agent",
        status: "disconnected",
      });

      await expect(removeAgent(db, "agt_cross_tenant")).rejects.toThrow(ORPCError);

      const [row] = await db
        .select()
        .from(acprouterAgents)
        .where(eq(acprouterAgents.id, "agt_cross_tenant"));
      expect(row?.deletedAt).toBeNull();
    });

    it("rejects a nonexistent agent id as not-found", async () => {
      await expect(removeAgent(db, "agt_does_not_exist")).rejects.toThrow(ORPCError);
    });

    it("rejects an already-removed agent id as not-found on the second call", async () => {
      const { agentId } = await createBridgedAgent("disconnected");
      await expect(removeAgent(db, agentId)).resolves.toEqual({ ok: true });
      await expect(removeAgent(db, agentId)).rejects.toThrow(ORPCError);
    });

    it("a removed agent is absent from a subsequent listAgents call, and getAgentById no longer resolves it", async () => {
      const { agentId } = await createBridgedAgent("disconnected");
      await removeAgent(db, agentId);

      expect(await listAgents(db)).toHaveLength(0);
      expect(await getAgentById(db, agentId)).toBeUndefined();
    });

    it("removing one agent does not affect another agent on the same machine's sibling registrySlug, or a sibling machine", async () => {
      const machineId = await createMachine("shared-machine");
      await upsertBridgedAgent(db, {
        ownerId: OWNER_ID,
        machineId,
        registrySlug: "claude-acp",
        label: "Claude Code",
        cwd: "/a",
        detectedVersion: null,
        status: "disconnected",
      });
      await upsertBridgedAgent(db, {
        ownerId: OWNER_ID,
        machineId,
        registrySlug: "codex-acp",
        label: "Codex",
        cwd: "/b",
        detectedVersion: null,
        status: "disconnected",
      });
      const agents = await listAgents(db);
      const toRemove = agents.find((a) => a.registrySlug === "claude-acp");
      if (!toRemove) throw new Error("expected claude-acp agent to exist");

      await removeAgent(db, toRemove.id);

      const remaining = await listAgents(db);
      expect(remaining).toHaveLength(1);
      expect(remaining[0].registrySlug).toBe("codex-acp");

      const [machineRow] = await db
        .select()
        .from(acprouterMachines)
        .where(eq(acprouterMachines.id, machineId));
      expect(machineRow).toBeDefined();
    });

    it("revokes every live consumer API key for the removed agent in the same transaction, so an old key can no longer authenticate", async () => {
      const { agentId } = await createBridgedAgent("disconnected");
      const minted = await mintConsumerApiKey(db, agentId, "prod", "http://example.test");

      expect(await validateConsumerApiKey(db, agentId, minted.rawKey)).toBe(true);

      await removeAgent(db, agentId);

      const [keyRow] = await db
        .select()
        .from(acprouterConsumerApiKeys)
        .where(eq(acprouterConsumerApiKeys.id, minted.key.id));
      expect(keyRow?.revokedAt).not.toBeNull();
      expect(await validateConsumerApiKey(db, agentId, minted.rawKey)).toBe(false);
    });

    it("does not revoke a key for an ineligible (connected) agent whose removal was rejected", async () => {
      const { agentId } = await createBridgedAgent("connected");
      const minted = await mintConsumerApiKey(db, agentId, "prod", "http://example.test");

      await expect(removeAgent(db, agentId)).resolves.toEqual({ ok: false });

      expect(await validateConsumerApiKey(db, agentId, minted.rawKey)).toBe(true);
    });

    it("does not revoke a different agent's key when removing one agent", async () => {
      const { agentId: removedId } = await createBridgedAgent("disconnected", "claude-acp");
      const { agentId: otherId } = await createBridgedAgent("disconnected", "codex-acp");
      const otherKey = await mintConsumerApiKey(db, otherId, "prod", "http://example.test");

      await removeAgent(db, removedId);

      expect(await validateConsumerApiKey(db, otherId, otherKey.rawKey)).toBe(true);
    });

    it("mintConsumerApiKey rejects once the agent row is gone, even if a concurrent removal commits first", async () => {
      const { agentId } = await createBridgedAgent("disconnected");

      // Not literal thread interleaving (single-process test), but exercises
      // the exact state mintConsumerApiKey's own transaction must reject:
      // the agent row already has deletedAt set by the time the mint's
      // locking SELECT runs.
      await removeAgent(db, agentId);

      await expect(
        mintConsumerApiKey(db, agentId, "prod", "http://example.test"),
      ).rejects.toMatchObject({ code: "NOT_FOUND" });

      const keyRows = await db
        .select()
        .from(acprouterConsumerApiKeys)
        .where(eq(acprouterConsumerApiKeys.agentId, agentId));
      expect(keyRows).toHaveLength(0);
    });

    it("mintConsumerApiKey and removeAgent run back-to-back never both succeed — the surviving key (if any) is unusable", async () => {
      // PGLite is a single in-process connection: two `db.transaction()` calls
      // fired via Promise.allSettled do not actually interleave inside
      // Postgres the way two real connections racing a FOR UPDATE lock
      // would — they just run one after the other on the one connection.
      // This proves the two operations' END STATE is always consistent
      // (never a live key on a removed agent), not that the FOR UPDATE lock
      // itself blocks a second real connection — see
      // `mintConsumerApiKey locks the agent row` below for that half,
      // proven by SQL shape instead, which runs on any backend.
      const { agentId } = await createBridgedAgent("disconnected");

      const [mintResult, removeResult] = await Promise.allSettled([
        mintConsumerApiKey(db, agentId, "prod", "http://example.test"),
        removeAgent(db, agentId),
      ]);

      expect(removeResult.status).toBe("fulfilled");
      if (removeResult.status === "fulfilled") {
        expect(removeResult.value).toEqual({ ok: true });
      }

      if (mintResult.status === "fulfilled") {
        expect(await validateConsumerApiKey(db, agentId, mintResult.value.rawKey)).toBe(false);
      }
    });

    it("a key minted for an agent that is later removed is rejected by validateConsumerApiKey even if something left it unrevoked", async () => {
      const { agentId } = await createBridgedAgent("disconnected");
      const minted = await mintConsumerApiKey(db, agentId, "prod", "http://example.test");

      await removeAgent(db, agentId);

      // Simulate a key that survived removal's revocation sweep unrevoked
      // (the scenario the live-agent join in validateConsumerApiKey exists
      // to close even when revocation itself is somehow bypassed).
      await db
        .update(acprouterConsumerApiKeys)
        .set({ revokedAt: null })
        .where(eq(acprouterConsumerApiKeys.id, minted.key.id));

      expect(await validateConsumerApiKey(db, agentId, minted.rawKey)).toBe(false);
    });

    it("validateConsumerApiKey rejects a key inserted directly against an already-removed agent row", async () => {
      const { agentId } = await createBridgedAgent("disconnected");
      await removeAgent(db, agentId);

      const rawKey = "ack_test_key_against_removed_agent";
      await db.insert(acprouterConsumerApiKeys).values({
        id: "cak_test_against_removed",
        agentId,
        label: "inserted after delete",
        keyHash: hashToken(rawKey),
      });

      expect(await validateConsumerApiKey(db, agentId, rawKey)).toBe(false);
    });

    async function createRemoteAcpAgent(status: "connected" | "disconnected" = "disconnected") {
      const id = "agt_remote_test";
      await db.insert(acprouterAgents).values({
        id,
        ownerId: OWNER_ID,
        machineId: null,
        kind: "remote-acp",
        registrySlug: null,
        label: "Remote Agent",
        status,
      });
      return id;
    }

    function fakeConnection() {
      return {
        signal: new AbortController().signal,
        closed: new Promise<void>(() => {}),
        close: vi.fn(),
        agent: {} as unknown,
      };
    }

    function fakeSocket() {
      return { close: vi.fn() };
    }

    it("ends every non-terminal session row for a removed agent", async () => {
      const agentId = await createRemoteAcpAgent("disconnected");
      await insertActiveSession(db, { id: "ses_active", agentId, consumerId: null });
      await insertActiveSession(db, { id: "ses_idle", agentId, consumerId: null });
      await db
        .update(acprouterAgentSessions)
        .set({ status: "idle" })
        .where(eq(acprouterAgentSessions.id, "ses_idle"));

      await removeAgent(db, agentId);

      const rows = await db
        .select()
        .from(acprouterAgentSessions)
        .where(eq(acprouterAgentSessions.agentId, agentId));
      expect(rows).toHaveLength(2);
      for (const row of rows) {
        expect(row.status).toBe("ended");
        expect(row.endedAt).not.toBeNull();
      }
    });

    it("leaves an already-ended or already-failed session row untouched", async () => {
      const agentId = await createRemoteAcpAgent("disconnected");
      await insertActiveSession(db, { id: "ses_ended", agentId, consumerId: null });
      await db
        .update(acprouterAgentSessions)
        .set({ status: "ended", endedAt: new Date("2020-01-01T00:00:00Z") })
        .where(eq(acprouterAgentSessions.id, "ses_ended"));

      await removeAgent(db, agentId);

      const [row] = await db
        .select()
        .from(acprouterAgentSessions)
        .where(eq(acprouterAgentSessions.id, "ses_ended"));
      expect(row?.endedAt?.toISOString()).toBe("2020-01-01T00:00:00.000Z");
    });

    it("does not touch session rows belonging to a different agent", async () => {
      const removedId = await createRemoteAcpAgent("disconnected");
      const otherId = "agt_remote_other";
      await db.insert(acprouterAgents).values({
        id: otherId,
        ownerId: OWNER_ID,
        machineId: null,
        kind: "remote-acp",
        registrySlug: null,
        label: "Other Remote Agent",
        status: "connected",
      });
      await insertActiveSession(db, { id: "ses_other", agentId: otherId, consumerId: null });

      await removeAgent(db, removedId);

      const [row] = await db
        .select()
        .from(acprouterAgentSessions)
        .where(eq(acprouterAgentSessions.id, "ses_other"));
      expect(row?.status).toBe("active");
      expect(row?.endedAt).toBeNull();
    });

    it("closes a live remote-session-registry connection and forgets its capabilities", async () => {
      const agentId = await createRemoteAcpAgent("disconnected");
      await insertActiveSession(db, { id: "ses_live", agentId, consumerId: null });
      const connection = fakeConnection();
      const socket = fakeSocket();
      registerRemoteSessionConnection(
        "ses_live",
        connection as unknown as Parameters<typeof registerRemoteSessionConnection>[1],
        socket as unknown as Parameters<typeof registerRemoteSessionConnection>[2],
      );

      await removeAgent(db, agentId);

      expect(getRemoteSessionConnection("ses_live")).toBeUndefined();
      expect(connection.close).toHaveBeenCalled();
      expect(socket.close).toHaveBeenCalled();
    });

    it("does not close a different session's live connection when removing an agent", async () => {
      const removedId = await createRemoteAcpAgent("disconnected");
      const otherId = "agt_remote_other_live";
      await db.insert(acprouterAgents).values({
        id: otherId,
        ownerId: OWNER_ID,
        machineId: null,
        kind: "remote-acp",
        registrySlug: null,
        label: "Other Remote Agent",
        status: "connected",
      });
      await insertActiveSession(db, { id: "ses_removed", agentId: removedId, consumerId: null });
      await insertActiveSession(db, { id: "ses_untouched", agentId: otherId, consumerId: null });
      const otherConnection = fakeConnection();
      const otherSocket = fakeSocket();
      registerRemoteSessionConnection(
        "ses_untouched",
        otherConnection as unknown as Parameters<typeof registerRemoteSessionConnection>[1],
        otherSocket as unknown as Parameters<typeof registerRemoteSessionConnection>[2],
      );

      await removeAgent(db, removedId);

      expect(getRemoteSessionConnection("ses_untouched")).toBeDefined();
      expect(otherConnection.close).not.toHaveBeenCalled();
      expect(otherSocket.close).not.toHaveBeenCalled();
    });

    it("ending sessions for an agent with no session rows is a no-op, not an error", async () => {
      const agentId = await createRemoteAcpAgent("disconnected");
      await expect(removeAgent(db, agentId)).resolves.toEqual({ ok: true });
    });
  });

  describe("removeAgent concurrent re-enrollment (reconnect race)", () => {
    it("concurrent removal and reconnect reports for the same (machineId, registrySlug) settle into a consistent state — never both removed and connected", async () => {
      const machineId = await createMachine();
      await upsertBridgedAgent(db, {
        ownerId: OWNER_ID,
        machineId,
        registrySlug: "claude-acp",
        label: "Claude Code",
        cwd: "/first",
        detectedVersion: null,
        status: "disconnected",
      });
      const [existing] = await listAgents(db);

      const [removeResult] = await Promise.all([
        removeAgent(db, existing.id),
        upsertBridgedAgent(db, {
          ownerId: OWNER_ID,
          machineId,
          registrySlug: "claude-acp",
          label: "Claude Code",
          cwd: "/reconnected",
          detectedVersion: null,
          status: "connected",
        }),
      ]);

      // Which transaction's conditional UPDATE/upsert commits first is a genuine
      // race — both outcomes are legitimate, but exactly one agent must ever be
      // active for this (machineId, registrySlug) pair, and a soft-removed row
      // must never report as connected.
      const activeAgents = await listAgents(db);
      expect(activeAgents).toHaveLength(1);

      const rows = await db
        .select()
        .from(acprouterAgents)
        .where(eq(acprouterAgents.machineId, machineId));
      const removedRow = rows.find((r) => r.id === existing.id);

      if (removeResult.ok) {
        // Removal won: the old row is tombstoned and disconnected; the
        // reconnect's upsert landed as a brand-new connected row.
        expect(rows).toHaveLength(2);
        expect(removedRow?.deletedAt).not.toBeNull();
        expect(removedRow?.status).toBe("disconnected");
        expect(activeAgents[0].id).not.toBe(existing.id);
        expect(activeAgents[0].status).toBe("connected");
      } else {
        // Reconnect won: the conditional removal UPDATE matched zero rows
        // because the row was no longer disconnected, so it is untouched —
        // same row, still active, now connected.
        expect(rows).toHaveLength(1);
        expect(removedRow?.deletedAt).toBeNull();
        expect(activeAgents[0].id).toBe(existing.id);
        expect(activeAgents[0].status).toBe("connected");
      }
    });

    it("reconnect that commits before removal reads the row leaves removal rejected as ineligible, not removed", async () => {
      const machineId = await createMachine();
      await upsertBridgedAgent(db, {
        ownerId: OWNER_ID,
        machineId,
        registrySlug: "claude-acp",
        label: "Claude Code",
        cwd: "/first",
        detectedVersion: null,
        status: "disconnected",
      });
      const [existing] = await listAgents(db);

      await upsertBridgedAgent(db, {
        ownerId: OWNER_ID,
        machineId,
        registrySlug: "claude-acp",
        label: "Claude Code",
        cwd: "/reconnected",
        detectedVersion: null,
        status: "connected",
      });

      const removeResult = await removeAgent(db, existing.id);
      expect(removeResult).toEqual({ ok: false });

      const activeAgents = await listAgents(db);
      expect(activeAgents).toHaveLength(1);
      expect(activeAgents[0].id).toBe(existing.id);
      expect(activeAgents[0].status).toBe("connected");

      const [row] = await db
        .select()
        .from(acprouterAgents)
        .where(eq(acprouterAgents.id, existing.id));
      expect(row?.deletedAt).toBeNull();
    });

    it("removal that commits before a reconnect arrives tombstones the old row, and the reconnect lands as a fresh connected row", async () => {
      const machineId = await createMachine();
      await upsertBridgedAgent(db, {
        ownerId: OWNER_ID,
        machineId,
        registrySlug: "claude-acp",
        label: "Claude Code",
        cwd: "/first",
        detectedVersion: null,
        status: "disconnected",
      });
      const [existing] = await listAgents(db);

      const removeResult = await removeAgent(db, existing.id);
      expect(removeResult).toEqual({ ok: true });

      await upsertBridgedAgent(db, {
        ownerId: OWNER_ID,
        machineId,
        registrySlug: "claude-acp",
        label: "Claude Code",
        cwd: "/reconnected",
        detectedVersion: null,
        status: "connected",
      });

      const activeAgents = await listAgents(db);
      expect(activeAgents).toHaveLength(1);
      expect(activeAgents[0].id).not.toBe(existing.id);
      expect(activeAgents[0].status).toBe("connected");

      const [removedRow] = await db
        .select()
        .from(acprouterAgents)
        .where(eq(acprouterAgents.id, existing.id));
      expect(removedRow?.deletedAt).not.toBeNull();
      expect(removedRow?.status).toBe("disconnected");
    });
  });

  describe("upsertBridgedAgent after removal (reconnect race)", () => {
    it("a reconnect for the same (machineId, registrySlug) after removal inserts a brand-new row, leaving the removed row's own fields untouched", async () => {
      const machineId = await createMachine();
      await upsertBridgedAgent(db, {
        ownerId: OWNER_ID,
        machineId,
        registrySlug: "claude-acp",
        label: "Claude Code",
        cwd: "/old/dir",
        detectedVersion: "1.0.0",
        status: "disconnected",
      });
      const [original] = await listAgents(db);
      await removeAgent(db, original.id);
      expect(await getAgentByMachineId(db, machineId)).toBeUndefined();

      await upsertBridgedAgent(db, {
        ownerId: OWNER_ID,
        machineId,
        registrySlug: "claude-acp",
        label: "Claude Code",
        cwd: "/new/dir",
        detectedVersion: "2.0.0",
        status: "connected",
      });

      const activeAgents = await listAgents(db);
      expect(activeAgents).toHaveLength(1);
      expect(activeAgents[0].id).not.toBe(original.id);
      expect(activeAgents[0].cwd).toBe("/new/dir");
      expect(activeAgents[0].status).toBe("connected");
      expect((await getAgentByMachineId(db, machineId))?.id).toBe(activeAgents[0].id);

      const [removedRow] = await db
        .select()
        .from(acprouterAgents)
        .where(eq(acprouterAgents.id, original.id));
      expect(removedRow?.deletedAt).not.toBeNull();
      expect(removedRow?.cwd).toBe("/old/dir");
      expect(removedRow?.detectedVersion).toBe("1.0.0");

      const rows = await db
        .select()
        .from(acprouterAgents)
        .where(eq(acprouterAgents.machineId, machineId));
      expect(rows).toHaveLength(2);
    });

    it("the partial unique index allows two rows (one removed, one active) for the same (machineId, registrySlug) pair at the database level", async () => {
      const machineId = await createMachine();
      await upsertBridgedAgent(db, {
        ownerId: OWNER_ID,
        machineId,
        registrySlug: "claude-acp",
        label: "Claude Code",
        cwd: "/first",
        detectedVersion: null,
        status: "disconnected",
      });
      const [first] = await listAgents(db);
      await removeAgent(db, first.id);

      // Direct insert (not through upsertBridgedAgent) to prove the DATABASE
      // itself — not just application-level logic — allows this, i.e. the
      // unique index really is partial, not merely bypassed by app code.
      await expect(
        db.insert(acprouterAgents).values({
          id: "agt_second_direct",
          ownerId: OWNER_ID,
          machineId,
          kind: "bridged",
          registrySlug: "claude-acp",
          label: "Claude Code",
          status: "connected",
        }),
      ).resolves.not.toThrow();

      const rows = await db
        .select()
        .from(acprouterAgents)
        .where(eq(acprouterAgents.machineId, machineId));
      expect(rows).toHaveLength(2);
    });

    it("a reconnect after removal inserts a fresh row rather than writing through the soft-deleted row", async () => {
      const machineId = await createMachine();
      await upsertBridgedAgent(db, {
        ownerId: OWNER_ID,
        machineId,
        registrySlug: "claude-acp",
        label: "Claude Code",
        cwd: "/first",
        detectedVersion: null,
        status: "disconnected",
      });
      const [existing] = await listAgents(db);

      await removeAgent(db, existing.id);

      await upsertBridgedAgent(db, {
        ownerId: OWNER_ID,
        machineId,
        registrySlug: "claude-acp",
        label: "Claude Code",
        cwd: "/reconnected",
        detectedVersion: null,
        status: "connected",
      });

      const activeAgents = await listAgents(db);
      expect(activeAgents).toHaveLength(1);
      expect(activeAgents[0].id).not.toBe(existing.id);
      expect(activeAgents[0].status).toBe("connected");

      const [removedRow] = await db
        .select()
        .from(acprouterAgents)
        .where(eq(acprouterAgents.id, existing.id));
      // Never both removed AND reporting connected — the removed row must
      // stay exactly as the removal left it, not get overwritten by the
      // reconnect.
      expect(removedRow?.deletedAt).not.toBeNull();
      expect(removedRow?.status).toBe("disconnected");
    });

    it("two upsertBridgedAgent calls fired together for the same fresh (machineId, registrySlug) pair settle into one row, not a unique-constraint error", async () => {
      // Same PGLite single-connection caveat as above: this proves the
      // atomic ON CONFLICT statement is correct (one row survives, no
      // thrown unique-violation) when the two calls happen to serialize on
      // the one connection — it does not exercise two real Postgres
      // connections hitting the partial index at the same instant.
      const machineId = await createMachine();

      const results = await Promise.allSettled([
        upsertBridgedAgent(db, {
          ownerId: OWNER_ID,
          machineId,
          registrySlug: "claude-acp",
          label: "Claude Code",
          cwd: "/race-a",
          detectedVersion: null,
          status: "connected",
        }),
        upsertBridgedAgent(db, {
          ownerId: OWNER_ID,
          machineId,
          registrySlug: "claude-acp",
          label: "Claude Code",
          cwd: "/race-b",
          detectedVersion: null,
          status: "connected",
        }),
      ]);

      expect(results.every((r) => r.status === "fulfilled")).toBe(true);

      const rows = await db
        .select()
        .from(acprouterAgents)
        .where(eq(acprouterAgents.machineId, machineId));
      expect(rows).toHaveLength(1);
      expect(["/race-a", "/race-b"]).toContain(rows[0].cwd);
    });
  });
});
