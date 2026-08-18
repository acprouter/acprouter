import { and, eq, ne } from "drizzle-orm";
import type { Database } from "../../../db";
import { acprouterAgentSessions } from "../schema/agent-sessions";

/**
 * Owns every write to `acprouterAgentSessions`'s `status` column — kept in
 * its own file (not `sessions-logic.ts`) so `session-relay-registry.ts` can
 * import it directly without a cycle: the registry is what actually SEES a
 * `turn_ended`/`session_ended` event first (some of them originate inside
 * the registry itself, e.g. the permission-timeout path), and `sessions-
 * logic.ts` already imports the registry, so the registry importing back
 * from `sessions-logic.ts` would be circular.
 */

export interface InsertActiveSessionInput {
  id: string;
  agentId: string;
  consumerId: string | null;
}

/**
 * Which agent a session belongs to — the lookup callers need BEFORE trusting
 * a caller-supplied `sessionId` for anything tenant-sensitive. This file
 * already owns every write to `acprouterAgentSessions` (see the module doc
 * comment); this is the one read the ownership checks in
 * `session-events-logic.ts`'s `listSessionEvents` and `sessions-logic.ts`'s
 * `answerAgentSessionPermission` both need, so it lives here rather than
 * being re-derived in each of those files. Returns `undefined` for an
 * unrecognized session id — same "let the caller decide the NOT_FOUND" shape
 * as `getAgentById`; callers pair this with `getAgentById(db, agentId)` to
 * confirm the session's agent is actually the caller's own.
 */
export async function getSessionAgentId(
  db: Database,
  sessionId: string,
): Promise<string | undefined> {
  const [row] = await db
    .select({ agentId: acprouterAgentSessions.agentId })
    .from(acprouterAgentSessions)
    .where(eq(acprouterAgentSessions.id, sessionId))
    .limit(1);
  return row?.agentId;
}

/** One row per `session/new` (task #12) — inserted with `status: "active"` the moment a real ACP session is created. */
export async function insertActiveSession(
  db: Database,
  input: InsertActiveSessionInput,
): Promise<void> {
  await db.insert(acprouterAgentSessions).values({
    id: input.id,
    agentId: input.agentId,
    consumerId: input.consumerId,
    status: "active",
  });
}

/**
 * `"ended"` (an explicit `endAgentSession` cancel) is the one status this
 * file treats as terminal-and-final: every other transition below guards
 * with `status != "ended"` so a stray `turn_ended`/`session_ended` event that
 * resolves AFTER the user already cancelled (the pending `session/prompt`
 * settling on its own, moments later) cannot resurrect a session the user
 * explicitly ended.
 */
async function markStatusUnlessEnded(
  db: Database,
  sessionId: string,
  status: "active" | "idle" | "failed",
): Promise<void> {
  await db
    .update(acprouterAgentSessions)
    .set({ status, updatedAt: new Date() })
    .where(
      and(eq(acprouterAgentSessions.id, sessionId), ne(acprouterAgentSessions.status, "ended")),
    );
}

/** Re-armed at the start of every `promptAgentSession` call — a session that went `idle` after turn 1 reads `active` again the instant turn 2 starts. */
export async function markSessionActive(db: Database, sessionId: string): Promise<void> {
  await markStatusUnlessEnded(db, sessionId, "active");
}

/** A completed turn with the session still open for another prompt (`turn_ended`) — NOT still "active", since nothing is running right now. */
export async function markSessionIdle(db: Database, sessionId: string): Promise<void> {
  await markStatusUnlessEnded(db, sessionId, "idle");
}

/** Every `session_ended` this Router itself emits is an abnormal stop — the prompt request rejecting (`promptAgentSession`'s `.catch`) or nobody answering a permission request in time (`session-relay-registry.ts`'s timeout). A real user-initiated stop goes through `markSessionEnded` below instead, never through this path. */
export async function markSessionFailed(db: Database, sessionId: string): Promise<void> {
  await markStatusUnlessEnded(db, sessionId, "failed");
}

/** `endAgentSession`'s real cancel (task #11) — unconditional, since an explicit user action always wins over whatever the in-flight turn resolves to afterward. */
export async function markSessionEnded(db: Database, sessionId: string): Promise<void> {
  await db
    .update(acprouterAgentSessions)
    .set({ status: "ended", updatedAt: new Date(), endedAt: new Date() })
    .where(eq(acprouterAgentSessions.id, sessionId));
}
