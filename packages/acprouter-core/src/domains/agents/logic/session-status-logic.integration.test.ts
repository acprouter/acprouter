import { rmSync } from "node:fs";
import path from "node:path";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { type Database, getDb } from "../../../db";
import { acprouterAgentSessions, acprouterAgents } from "../../../db/schema";
import {
  insertActiveSession,
  markSessionActive,
  markSessionEnded,
  markSessionFailed,
  markSessionIdle,
} from "./session-status-logic";

const SCRATCH_DIR = ".data/session-status-logic-test";

/** Real PGLite — proves task #12's `acprouter_agent_sessions` state machine: `active` on create, `idle` after a completed turn, `failed` on an abnormal stop, `ended` on an explicit cancel, and that `ended` always wins over a later transition. */
describe("session-status-logic", () => {
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
    await db.delete(acprouterAgentSessions);
    await db.delete(acprouterAgents);
  });

  let agentCounter = 0;
  async function createAgent(): Promise<string> {
    agentCounter += 1;
    const id = `agt_status_test_${agentCounter}`;
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

  async function statusOf(sessionId: string): Promise<string | undefined> {
    const [row] = await db
      .select({ status: acprouterAgentSessions.status })
      .from(acprouterAgentSessions)
      .where(eq(acprouterAgentSessions.id, sessionId));
    return row?.status;
  }

  it("insertActiveSession creates a real row with status active", async () => {
    const agentId = await createAgent();
    const sessionId = "sess_active_1";
    await insertActiveSession(db, { id: sessionId, agentId, consumerId: null });
    expect(await statusOf(sessionId)).toBe("active");
  });

  it("markSessionIdle flips active -> idle (a completed turn, session still open)", async () => {
    const agentId = await createAgent();
    const sessionId = "sess_idle_1";
    await insertActiveSession(db, { id: sessionId, agentId, consumerId: null });

    await markSessionIdle(db, sessionId);
    expect(await statusOf(sessionId)).toBe("idle");
  });

  it("markSessionActive re-arms idle -> active (a new prompt on a previously-idle session)", async () => {
    const agentId = await createAgent();
    const sessionId = "sess_reactivate_1";
    await insertActiveSession(db, { id: sessionId, agentId, consumerId: null });
    await markSessionIdle(db, sessionId);
    expect(await statusOf(sessionId)).toBe("idle");

    await markSessionActive(db, sessionId);
    expect(await statusOf(sessionId)).toBe("active");
  });

  it("markSessionFailed flips active -> failed (the promptAgentSession .catch path / a permission timeout)", async () => {
    const agentId = await createAgent();
    const sessionId = "sess_failed_1";
    await insertActiveSession(db, { id: sessionId, agentId, consumerId: null });

    await markSessionFailed(db, sessionId);
    expect(await statusOf(sessionId)).toBe("failed");
  });

  it("markSessionEnded flips active -> ended and stamps endedAt", async () => {
    const agentId = await createAgent();
    const sessionId = "sess_ended_1";
    await insertActiveSession(db, { id: sessionId, agentId, consumerId: null });

    await markSessionEnded(db, sessionId);
    const [row] = await db
      .select()
      .from(acprouterAgentSessions)
      .where(eq(acprouterAgentSessions.id, sessionId));
    expect(row?.status).toBe("ended");
    expect(row?.endedAt).not.toBeNull();
  });

  it("ended always wins: a turn_ended/session_ended-shaped write AFTER an explicit end() does not resurrect the session", async () => {
    const agentId = await createAgent();
    const sessionId = "sess_ended_wins_1";
    await insertActiveSession(db, { id: sessionId, agentId, consumerId: null });

    // The user explicitly cancelled...
    await markSessionEnded(db, sessionId);
    expect(await statusOf(sessionId)).toBe("ended");

    // ...and THEN the in-flight session/prompt promise the cancel triggered
    // finally settles (the real race `session-status-logic.ts`'s doc comment
    // describes) — neither an `idle` nor a `failed` write should overwrite
    // the user's explicit "ended".
    await markSessionIdle(db, sessionId);
    expect(await statusOf(sessionId)).toBe("ended");

    await markSessionFailed(db, sessionId);
    expect(await statusOf(sessionId)).toBe("ended");
  });
});
