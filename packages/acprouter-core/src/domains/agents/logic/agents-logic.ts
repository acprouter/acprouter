import type { AgentVO } from "@acprouter/contract";
import { ORPCError } from "@orpc/server";
import { and, desc, eq, inArray, isNull, ne } from "drizzle-orm";
import { generateNanoID } from "openlib/nanoid";
import { resolveOwnerId } from "../../../context";
import type { Database } from "../../../db";
import { acprouterAgents, acprouterConsumerApiKeys } from "../../../db/schema";
import { acprouterAgentSessions } from "../schema/agent-sessions";
import type { AgentPO, AgentStatus } from "../schema/agents";
import { closeRemoteSessionConnection } from "./remote-session-registry";
import { forgetSessionCapabilities } from "./session-capabilities-registry";

/** Shared by `remote-agents-logic.ts`, which inserts `remote-acp` rows directly rather than through `upsertBridgedAgent`'s path, so both kinds map PO→VO the same way. */
export function toAgentVO(row: AgentPO): AgentVO {
  return {
    id: row.id,
    kind: row.kind,
    registrySlug: row.registrySlug,
    label: row.label,
    machineId: row.machineId,
    cwd: row.cwd,
    detectedVersion: row.detectedVersion,
    status: row.status,
    statusDetail: row.statusDetail,
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** `machines.list`'s counterpart for agents. Excludes soft-removed rows (`deletedAt`) from every read, same posture as `acprouter_consumer_api_keys.revokedAt`. */
export async function listAgents(db: Database): Promise<AgentVO[]> {
  const rows = await db
    .select()
    .from(acprouterAgents)
    .where(and(eq(acprouterAgents.ownerId, resolveOwnerId()), isNull(acprouterAgents.deletedAt)))
    .orderBy(desc(acprouterAgents.createdAt));
  return rows.map(toAgentVO);
}

/** Looks up the raw PO (not the VO) — `sessions-logic.ts` needs `machineId` to find the live bridge, which `AgentVO` deliberately never exposes to the browser as more than an opaque string. Excludes soft-removed rows: this is the single ownership/existence chokepoint `assertOwnsAgent`, `sessions-logic.ts`'s connection resolvers, and `endAgentSession` all reuse, so a removed agent's id rejects as not-found everywhere with no further change needed at those call sites. */
export async function getAgentById(db: Database, agentId: string): Promise<AgentPO | undefined> {
  const [row] = await db
    .select()
    .from(acprouterAgents)
    .where(
      and(
        eq(acprouterAgents.id, agentId),
        eq(acprouterAgents.ownerId, resolveOwnerId()),
        isNull(acprouterAgents.deletedAt),
      ),
    )
    .limit(1);
  return row;
}

/**
 * Same lookup as `getAgentById`, but by `machineId` and WITHOUT the
 * `resolveOwnerId()` scope — needed by the Task 5.2 consumer-key completion
 * endpoint, a bearer-token-authenticated call with no session actor to
 * resolve an ambient owner from (same reasoning as `getMachineOwnerId` in
 * `machines-logic.ts`). Callers that DO have a session actor must keep using
 * `getAgentById`; this is for the grant-authenticated enrollment surface
 * only, which already scopes trust via the caller's own `grantId`/
 * `enrollmentId`, not an owner session.
 */
export async function getAgentByMachineId(
  db: Database,
  machineId: string,
): Promise<AgentPO | undefined> {
  const [row] = await db
    .select()
    .from(acprouterAgents)
    .where(and(eq(acprouterAgents.machineId, machineId), isNull(acprouterAgents.deletedAt)))
    .limit(1);
  return row;
}

export interface UpsertBridgedAgentInput {
  ownerId: string;
  machineId: string;
  registrySlug: string;
  label: string;
  cwd: string | null;
  detectedVersion: string | null;
  status: AgentStatus;
  /** The "exact next step" string surfaced to the user, if any (e.g. a sign-in instruction). */
  statusDetail?: string | null;
}

/**
 * Upserts the one `bridged` agent row for a `(machineId, registrySlug)` pair
 * — the MVP CLI is single-agent-per-machine, so this pairing is a stable
 * natural key. Called every time a machine's `initialize` response carries
 * a usable `_meta`, so a machine that reconnects with a changed `cwd` or a
 * resolved `auth_required` state overwrites the same row rather than
 * accumulating stale duplicates.
 *
 * A single atomic `INSERT ... ON CONFLICT (machineId, registrySlug) WHERE
 * deletedAt IS NULL DO UPDATE`, not a separate lookup followed by an
 * update-or-insert branch: two concurrent reconnects for the same pair used
 * to both miss each other in the lookup `SELECT`, then both attempt the
 * insert branch — one would win, the other would hit the partial unique
 * index violation and throw instead of upserting. The conflict target's own
 * `targetWhere` mirrors the schema's partial index: it only matches a
 * *live* row for this pair, so a still-soft-deleted row occupying the same
 * pair is never a conflict target and is never written through — a
 * reconnect after removal always lands as a brand-new row.
 */
export async function upsertBridgedAgent(
  db: Database,
  input: UpsertBridgedAgentInput,
): Promise<void> {
  const statusDetail = input.statusDetail ?? null;

  await db
    .insert(acprouterAgents)
    .values({
      id: generateNanoID("agt_"),
      ownerId: input.ownerId,
      machineId: input.machineId,
      kind: "bridged",
      registrySlug: input.registrySlug,
      label: input.label,
      cwd: input.cwd,
      detectedVersion: input.detectedVersion,
      status: input.status,
      statusDetail,
    })
    .onConflictDoUpdate({
      target: [acprouterAgents.machineId, acprouterAgents.registrySlug],
      targetWhere: isNull(acprouterAgents.deletedAt),
      set: {
        label: input.label,
        cwd: input.cwd,
        detectedVersion: input.detectedVersion,
        status: input.status,
        statusDetail,
        updatedAt: new Date(),
      },
    });
}

/**
 * Flips every agent row belonging to a machine to `disconnected` the instant
 * its bridge socket closes — called alongside `markMachineOffline` from the
 * same socket-close handler, so an agent card never keeps reading
 * `connected` after the machine it lives on has gone away. Never throws
 * over a machine with no agent rows yet — same "best effort, nothing to
 * report" posture as `markMachineOffline`.
 */
export async function markAgentsDisconnected(db: Database, machineId: string): Promise<void> {
  await db
    .update(acprouterAgents)
    .set({ status: "disconnected", updatedAt: new Date() })
    .where(eq(acprouterAgents.machineId, machineId));
}

/**
 * Soft-removes one of the caller's own agent rows, never a hard `DELETE` —
 * four other tables carry a NOT NULL FK to this table's id with no
 * `onDelete`, so a physical delete of any agent that ever had a
 * credential/session/consumer-key/usage row fails at the database level.
 *
 * Eligible only when `status = 'disconnected'` — NOT `auth_required`,
 * `error`, or `connected`.
 *
 * A single atomic conditional `UPDATE ... WHERE id = ? AND ownerId = ? AND
 * status = 'disconnected' AND deletedAt IS NULL RETURNING ...` re-checks the
 * agent's current status at mutation time rather than trusting a status the
 * caller read earlier — the agents page polls periodically, so a card the
 * user clicked "Remove" on can be stale by the time this runs; an agent
 * that is no longer `disconnected` must never be removable even if the
 * client's last poll still shows it as eligible. Same `.returning()`
 * no-read-then-write-race shape `revokeConsumerApiKey` already uses for its
 * own double-revoke guard.
 *
 * Distinguishes two different "no" outcomes:
 * - **Not found, not owned, or already removed** → throws
 *   `ORPCError("NOT_FOUND")`, the same posture `assertOwnsAgent` already uses
 *   for "caller-supplied id that isn't theirs" — a cross-tenant id and a
 *   nonexistent id get the identical response, never revealing which case it
 *   was.
 * - **Exists, owned, not yet removed, but not currently `disconnected`**
 *   (i.e. `connected`, `auth_required`, or `error`) → returns `{ ok: false }`
 *   rather than throwing, since the row is real and the caller does own it;
 *   it is simply not eligible for this capability right now. The caller (the
 *   router/UI) treats this as "stay in the list, surface the failure" rather
 *   than a hard error page.
 *
 * Also revokes every one of this agent's consumer API keys in the same
 * transaction, atomically with the soft-delete, so a removed agent's
 * existing keys are marked revoked immediately rather than only becoming
 * unusable the next time something reads `acprouterAgents.deletedAt`.
 * `validateConsumerApiKey` additionally joins against this row's
 * `deletedAt` directly (`consumer-api-keys-logic.ts`) as a second,
 * independent check — belt-and-suspenders against a key minted in the race
 * window around this same removal (see `mintConsumerApiKey`'s own `FOR
 * UPDATE` lock on this table, which this `UPDATE` serializes against).
 *
 * Also ends every non-terminal session row for this agent (`status` not
 * already `ended`/`failed`) in the same transaction — rejecting new session
 * operations via `getAgentById`'s filter is not enough on its own, because a
 * `remote-acp` session already mid-turn holds its own live WebSocket
 * (`remote-session-registry.ts`) that nothing else would ever close; without
 * this it would keep streaming until the agent on the other end happens to
 * finish or drop. `closeRemoteSessionConnection` closes that socket, which
 * makes the in-flight `connection.agent.request` in `promptAgentSession`
 * reject — its own `.catch` (`sessions-logic.ts`) then emits the terminal
 * stream event and the final status write for that turn, so this function
 * does not need to duplicate that notification. A `bridged` agent has no
 * per-session connection to close (its machine's bridge is one connection
 * shared across sessions, and this function only runs for `status =
 * 'disconnected'`, i.e. that bridge is already gone) — ending its session
 * rows here still matters so a stale `active`/`idle` row cannot be resumed
 * against a now-removed agent id.
 */
export async function removeAgent(db: Database, agentId: string): Promise<{ ok: boolean }> {
  const existing = await getAgentById(db, agentId);
  if (!existing) {
    throw new ORPCError("NOT_FOUND", { message: `No agent registered with id "${agentId}".` });
  }

  const result = await db.transaction(async (tx) => {
    const [removed] = await tx
      .update(acprouterAgents)
      .set({ deletedAt: new Date(), updatedAt: new Date() })
      .where(
        and(
          eq(acprouterAgents.id, agentId),
          eq(acprouterAgents.ownerId, resolveOwnerId()),
          eq(acprouterAgents.status, "disconnected"),
          isNull(acprouterAgents.deletedAt),
        ),
      )
      .returning();

    if (!removed) return { ok: false as const, endedSessionIds: [] as string[] };

    await tx
      .update(acprouterConsumerApiKeys)
      .set({ revokedAt: new Date() })
      .where(
        and(
          eq(acprouterConsumerApiKeys.agentId, agentId),
          isNull(acprouterConsumerApiKeys.revokedAt),
        ),
      );

    const liveSessions = await tx
      .select({ id: acprouterAgentSessions.id })
      .from(acprouterAgentSessions)
      .where(
        and(
          eq(acprouterAgentSessions.agentId, agentId),
          ne(acprouterAgentSessions.status, "ended"),
          ne(acprouterAgentSessions.status, "failed"),
        ),
      );
    const endedSessionIds = liveSessions.map((s) => s.id);
    // Inlined on `tx` directly rather than calling `markSessionEnded` (which
    // takes a plain `Database`) — drizzle's transaction client type isn't
    // structurally assignable to the `Database` union, same constraint
    // `remote-agent-credential.ts`'s own locked transaction works around the
    // identical way. Must stay inside this same transaction: these rows are
    // exactly what `startAgentSession`'s own `FOR UPDATE`-locked transaction
    // (`sessions-logic.ts`) checks for before it inserts a new session row
    // for this agent — the two transactions serialize on the agent row lock,
    // so ending every live session here before commit is what makes that
    // race resolve correctly either way it lands.
    if (endedSessionIds.length > 0) {
      await tx
        .update(acprouterAgentSessions)
        .set({ status: "ended", updatedAt: new Date(), endedAt: new Date() })
        .where(inArray(acprouterAgentSessions.id, endedSessionIds));
    }

    return { ok: true as const, endedSessionIds };
  });

  for (const sessionId of result.endedSessionIds) {
    closeRemoteSessionConnection(sessionId);
    forgetSessionCapabilities(sessionId);
  }
  return { ok: result.ok };
}
