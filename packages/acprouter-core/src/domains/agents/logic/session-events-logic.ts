import {
  type AgentSessionStreamEventVO,
  AgentSessionStreamEventVOSchema,
} from "@acprouter/contract";
import { ORPCError } from "@orpc/server";
import { and, asc, count, desc, eq, gt, lt } from "drizzle-orm";
import { generateNanoID } from "openlib/nanoid";
import type { Database } from "../../../db";
import { acprouterAgentSessionEvents } from "../schema/agent-session-events";
import { getAgentById } from "./agents-logic";
import { getSessionAgentId } from "./session-status-logic";

/**
 * Owns every write to and read from `acprouterAgentSessionEvents` — the
 * append-only persistence path spec §9 Phase 1 point 7 calls out by name
 * ("ship the retention policy in the same pass"). `session-relay-registry.ts`
 * calls `appendSessionEvent` as a fire-and-forget side effect of every event
 * it relays; nothing here ever gates that relay.
 */

/** `payload` stores the EXACT `AgentSessionStreamEventVO` shape the browser receives (see that type's own doc comment) — reusing it rather than inventing a second shape is what makes `listSessionEvents` below able to hand history straight back to the same UI reducer (`use-agent-session.ts`'s `applyEvent`) with zero translation. */
export async function appendSessionEvent(
  db: Database,
  sessionId: string,
  seq: number,
  event: AgentSessionStreamEventVO,
): Promise<void> {
  await db.insert(acprouterAgentSessionEvents).values({
    id: generateNanoID("sev_"),
    sessionId,
    seq,
    eventType: event.type,
    payload: event,
  });
}

/**
 * Real persisted history, in emission order — the read-back half of task
 * #12 (step 3): a `logic/` function backing the `sessions.history` oRPC
 * procedure. `AgentSessionStreamEventVOSchema.parse` re-validates each row
 * rather than trusting the JSONB blob blindly, catching drift between what
 * was written and what the current build's VO shape expects.
 *
 * `sessionId` alone carries no tenant information, so this first resolves
 * the session's owning agent (`getSessionAgentId`) and confirms it's the
 * caller's own (`getAgentById`, scoped to `resolveOwnerId()`) before
 * returning anything. Throws the same `NOT_FOUND` for "no such session" and
 * "session belongs to another tenant" — distinguishing them would leak
 * whether a given session id exists for someone else's agent.
 */
export async function listSessionEvents(
  db: Database,
  sessionId: string,
): Promise<AgentSessionStreamEventVO[]> {
  const agentId = await getSessionAgentId(db, sessionId);
  if (!agentId || !(await getAgentById(db, agentId))) {
    throw new ORPCError("NOT_FOUND", {
      message: `No session registered with id "${sessionId}".`,
    });
  }

  const rows = await db
    .select()
    .from(acprouterAgentSessionEvents)
    .where(eq(acprouterAgentSessionEvents.sessionId, sessionId))
    .orderBy(asc(acprouterAgentSessionEvents.seq));
  return rows.map((row) => AgentSessionStreamEventVOSchema.parse(row.payload));
}

/**
 * 14 days (owner's call): this is an "administer it" tool (spec §1.1), not a
 * chat-history product — long enough to debug "what happened in that session
 * yesterday/last week," short enough that a self-hosted operator's disk isn't
 * quietly accumulating a chatty tool-call log forever. Revisit if real usage
 * shows people reaching for older history than this.
 */
export const RETENTION_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;

/**
 * 5,000 events/session (owner's call): a belt-and-suspenders cap independent
 * of age — the retention window alone doesn't stop ONE session that's still
 * inside the window from accumulating unbounded rows (e.g. a runaway
 * tool-call loop). 5,000 is deliberately generous for a real conversation
 * (a long streamed reply is at most a few hundred `session_update` chunks)
 * so this only ever fires on genuinely pathological sessions, never a normal
 * one.
 */
export const MAX_EVENTS_PER_SESSION = 5000;

export interface RetentionSweepResult {
  deletedByAge: number;
  deletedByCap: number;
}

/**
 * The retention sweep spec §7/§9 point 7 requires shipping in the SAME pass
 * that starts writing to this table, not after. Invoked opportunistically
 * from `startAgentSession` (see that function's doc comment for why a
 * dedicated background scheduler/cron job was considered and rejected) —
 * "every new session" is frequent enough to bound growth in practice for a
 * self-hosted, single-operator tool, and cheap enough (`createdAt` and the
 * `(sessionId, seq)` unique index are both already indexed columns) not to
 * matter when it's a no-op, which is the common case.
 */
export async function sweepAgentSessionEvents(db: Database): Promise<RetentionSweepResult> {
  const cutoff = new Date(Date.now() - RETENTION_WINDOW_MS);
  // `.returning()` with no field selection, not `.returning({ id: ... })` —
  // `Database` is a union of the pglite and postgres-js drivers, and only
  // the zero-arg overload type-checks across both members of that union.
  // Whole rows back is fine here; only `.length` is used.
  const deletedByAge = await db
    .delete(acprouterAgentSessionEvents)
    .where(lt(acprouterAgentSessionEvents.createdAt, cutoff))
    .returning();

  const overflowing = await db
    .select({ sessionId: acprouterAgentSessionEvents.sessionId, total: count() })
    .from(acprouterAgentSessionEvents)
    .groupBy(acprouterAgentSessionEvents.sessionId)
    .having(gt(count(), MAX_EVENTS_PER_SESSION));

  let deletedByCap = 0;
  for (const { sessionId } of overflowing) {
    const kept = await db
      .select({ seq: acprouterAgentSessionEvents.seq })
      .from(acprouterAgentSessionEvents)
      .where(eq(acprouterAgentSessionEvents.sessionId, sessionId))
      .orderBy(desc(acprouterAgentSessionEvents.seq))
      .limit(MAX_EVENTS_PER_SESSION);
    const minKeptSeq = Math.min(...kept.map((row) => row.seq));
    const removed = await db
      .delete(acprouterAgentSessionEvents)
      .where(
        and(
          eq(acprouterAgentSessionEvents.sessionId, sessionId),
          lt(acprouterAgentSessionEvents.seq, minKeptSeq),
        ),
      )
      .returning();
    deletedByCap += removed.length;
  }

  return { deletedByAge: deletedByAge.length, deletedByCap };
}
