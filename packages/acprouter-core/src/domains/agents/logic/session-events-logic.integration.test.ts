import { rmSync } from "node:fs";
import path from "node:path";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { runWithMemberContext } from "../../../context";
import { type Database, getDb } from "../../../db";
import {
  acprouterAgentSessionEvents,
  acprouterAgentSessions,
  acprouterAgents,
} from "../../../db/schema";
import {
  appendSessionEvent,
  listSessionEvents,
  MAX_EVENTS_PER_SESSION,
  RETENTION_WINDOW_MS,
  sweepAgentSessionEvents,
} from "./session-events-logic";
import { insertActiveSession } from "./session-status-logic";

const SCRATCH_DIR = ".data/session-events-logic-test";

/**
 * Real PGLite, same shape as `agents-logic.integration.test.ts` — the
 * house style for this domain. Proves task #12's core promise: a real
 * session's events land in `acprouter_agent_session_events` in the right
 * order with the right `seq`, the retention sweep actually deletes rows
 * (both the age-based and per-session-cap paths), and history reads back in
 * order.
 */
describe("session-events-logic", () => {
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
    await db.delete(acprouterAgentSessionEvents);
    await db.delete(acprouterAgentSessions);
    await db.delete(acprouterAgents);
  });

  let agentCounter = 0;
  async function createAgent(): Promise<string> {
    agentCounter += 1;
    const id = `agt_test_${agentCounter}`;
    await db.insert(acprouterAgents).values({
      id,
      ownerId: "local",
      machineId: null,
      kind: "remote-acp",
      label: "Test Agent",
      status: "connected",
    });
    return id;
  }

  async function createSession(): Promise<string> {
    const agentId = await createAgent();
    const sessionId = `sess_${agentId}`;
    await insertActiveSession(db, { id: sessionId, agentId, consumerId: null });
    return sessionId;
  }

  /** Same as `createAgent`, parameterized by owner — used only by the
   *  tenant-scoping tests below, which need a specific, asserted ownerId
   *  rather than the module-default `"local"`. */
  async function createAgentForOwner(ownerId: string): Promise<string> {
    agentCounter += 1;
    const id = `agt_owner_test_${agentCounter}`;
    await db.insert(acprouterAgents).values({
      id,
      ownerId,
      machineId: null,
      kind: "remote-acp",
      label: "Test Agent",
      status: "connected",
    });
    return id;
  }

  async function createSessionForOwner(ownerId: string): Promise<string> {
    const agentId = await createAgentForOwner(ownerId);
    const sessionId = `sess_${agentId}`;
    await insertActiveSession(db, { id: sessionId, agentId, consumerId: null });
    return sessionId;
  }

  it("appendSessionEvent persists real rows, and listSessionEvents reads them back in seq order regardless of insertion order", async () => {
    const sessionId = await createSession();

    // Deliberately inserted out of seq order — `listSessionEvents` must sort
    // by `seq`, not rely on insertion/row order.
    await appendSessionEvent(db, sessionId, 2, {
      type: "session_update",
      update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "world" } },
    });
    await appendSessionEvent(db, sessionId, 1, {
      type: "session_update",
      update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "hello " } },
    });
    await appendSessionEvent(db, sessionId, 3, { type: "turn_ended", stopReason: "end_turn" });

    const events = await listSessionEvents(db, sessionId);
    expect(events).toHaveLength(3);
    expect(events[0]).toMatchObject({
      type: "session_update",
      update: { content: { text: "hello " } },
    });
    expect(events[1]).toMatchObject({
      type: "session_update",
      update: { content: { text: "world" } },
    });
    expect(events[2]).toEqual({ type: "turn_ended", stopReason: "end_turn" });
  });

  it("listSessionEvents only returns rows for the requested session, never another session's", async () => {
    const sessionA = await createSession();
    const sessionB = await createSession();

    await appendSessionEvent(db, sessionA, 1, { type: "turn_ended", stopReason: "end_turn" });
    await appendSessionEvent(db, sessionB, 1, {
      type: "session_ended",
      reason: "unrelated session",
    });

    expect(await listSessionEvents(db, sessionA)).toEqual([
      { type: "turn_ended", stopReason: "end_turn" },
    ]);
    expect(await listSessionEvents(db, sessionB)).toEqual([
      { type: "session_ended", reason: "unrelated session" },
    ]);
  });

  it("the unique (sessionId, seq) index rejects a real seq collision — proves seq really is the identity of an event, not just a display field", async () => {
    const sessionId = await createSession();
    await appendSessionEvent(db, sessionId, 1, { type: "turn_ended", stopReason: "end_turn" });
    await expect(
      appendSessionEvent(db, sessionId, 1, { type: "session_ended", reason: "duplicate seq" }),
    ).rejects.toThrow();
  });

  describe("listSessionEvents tenant scoping", () => {
    /**
     * Regression coverage for the gap flagged directly against this
     * function: `listSessionEvents(db, sessionId)` used to take only a bare
     * `sessionId` with zero check that the session's agent belongs to the
     * caller, so tenant B could read tenant A's session history (`sessions.
     * history`'s backing function) just by knowing (or guessing) tenant A's
     * `sessionId`. Same cross-tenant regression shape as
     * `machines-logic.integration.test.ts`'s own ownerId test.
     */
    it("a different tenant cannot read another tenant's session history — rejects NOT_FOUND instead of leaking it", async () => {
      const sessionId = await createSessionForOwner("tenant-a");
      await appendSessionEvent(db, sessionId, 1, { type: "turn_ended", stopReason: "end_turn" });

      await expect(
        runWithMemberContext({ db, ownerId: "tenant-b" }, () => listSessionEvents(db, sessionId)),
      ).rejects.toMatchObject({ code: "NOT_FOUND" });
    });

    it("the owning tenant can still read its own session history", async () => {
      const sessionId = await createSessionForOwner("tenant-a");
      await appendSessionEvent(db, sessionId, 1, { type: "turn_ended", stopReason: "end_turn" });

      const events = await runWithMemberContext({ db, ownerId: "tenant-a" }, () =>
        listSessionEvents(db, sessionId),
      );
      expect(events).toEqual([{ type: "turn_ended", stopReason: "end_turn" }]);
    });

    it("an unrecognized sessionId rejects NOT_FOUND regardless of the caller's tenant", async () => {
      await expect(
        runWithMemberContext({ db, ownerId: "tenant-a" }, () =>
          listSessionEvents(db, "sess_does_not_exist"),
        ),
      ).rejects.toMatchObject({ code: "NOT_FOUND" });
    });
  });

  describe("sweepAgentSessionEvents", () => {
    it("deletes rows older than the retention window and leaves recent rows untouched, using real backdated createdAt values", async () => {
      const sessionId = await createSession();

      const oldId = "sev_old";
      const recentId = "sev_recent";
      const oldCreatedAt = new Date(Date.now() - RETENTION_WINDOW_MS - 60_000); // 1 minute past the window
      const recentCreatedAt = new Date(Date.now() - 60_000); // 1 minute old, well inside the window

      await db.insert(acprouterAgentSessionEvents).values([
        {
          id: oldId,
          sessionId,
          seq: 1,
          eventType: "turn_ended",
          payload: { type: "turn_ended", stopReason: "end_turn" },
          createdAt: oldCreatedAt,
        },
        {
          id: recentId,
          sessionId,
          seq: 2,
          eventType: "turn_ended",
          payload: { type: "turn_ended", stopReason: "end_turn" },
          createdAt: recentCreatedAt,
        },
      ]);

      const result = await sweepAgentSessionEvents(db);
      expect(result.deletedByAge).toBeGreaterThanOrEqual(1);

      const remaining = await listSessionEvents(db, sessionId);
      expect(remaining).toHaveLength(1);

      const idsById = await db
        .select({ id: acprouterAgentSessionEvents.id })
        .from(acprouterAgentSessionEvents);
      expect(idsById.map((row) => row.id)).toEqual([recentId]);
      expect(idsById.map((row) => row.id)).not.toContain(oldId);
    });

    it("caps events per session independent of age — a session with more than MAX_EVENTS_PER_SESSION rows loses only the oldest excess, keeping the newest MAX_EVENTS_PER_SESSION", async () => {
      const sessionId = await createSession();
      const total = MAX_EVENTS_PER_SESSION + 25;
      const now = new Date();

      const rows = Array.from({ length: total }, (_, i) => ({
        id: `sev_cap_${i}`,
        sessionId,
        seq: i + 1,
        eventType: "turn_ended",
        payload: { type: "turn_ended" as const, stopReason: "end_turn" as const },
        createdAt: now, // all well within the retention window — only the cap should act
      }));
      // Insert in batches — a single 5000+ row VALUES statement is needlessly slow for a test.
      const BATCH = 500;
      for (let i = 0; i < rows.length; i += BATCH) {
        await db.insert(acprouterAgentSessionEvents).values(rows.slice(i, i + BATCH));
      }

      const result = await sweepAgentSessionEvents(db);
      expect(result.deletedByCap).toBe(25);

      const remaining = await listSessionEvents(db, sessionId);
      expect(remaining).toHaveLength(MAX_EVENTS_PER_SESSION);

      // The oldest 25 (seq 1..25) are the ones that should be gone — the
      // sweep keeps the NEWEST MAX_EVENTS_PER_SESSION, i.e. seq 26..total.
      const remainingSeqs = await db
        .select({ seq: acprouterAgentSessionEvents.seq })
        .from(acprouterAgentSessionEvents)
        .where(eq(acprouterAgentSessionEvents.sessionId, sessionId));
      expect(Math.min(...remainingSeqs.map((row) => row.seq))).toBe(26);
      expect(Math.max(...remainingSeqs.map((row) => row.seq))).toBe(total);
    });

    it("a session well under the cap and well within the retention window is left completely alone", async () => {
      const sessionId = await createSession();
      await appendSessionEvent(db, sessionId, 1, { type: "turn_ended", stopReason: "end_turn" });
      await appendSessionEvent(db, sessionId, 2, { type: "session_ended", reason: "done" });

      const result = await sweepAgentSessionEvents(db);
      expect(result.deletedByAge).toBe(0);
      expect(result.deletedByCap).toBe(0);
      expect(await listSessionEvents(db, sessionId)).toHaveLength(2);
    });
  });
});
