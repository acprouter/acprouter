import { randomBytes } from "node:crypto";
import type { ConsumerApiKeyVO, MintConsumerApiKeyOutput } from "@acprouter/contract";
import { ORPCError } from "@orpc/server";
import { and, desc, eq, gt, isNull } from "drizzle-orm";
import { generateNanoID } from "openlib/nanoid";
import type { Database } from "../../../db";
import {
  acprouterAgents,
  acprouterConsumerApiKeys,
  acprouterEnrollmentCompletions,
  acprouterEnrollmentTokens,
  acprouterMachineBridgeCredentials,
  acprouterMachines,
  acprouterRouterEnrollmentGrants,
} from "../../../db/schema";
import { getAgentById, getAgentByMachineId } from "./agents-logic";
import { closeConsumerAcpConnection, listConsumerAcpConnections } from "./consumer-acp-registry";
import { hashToken } from "./machines-logic";

/**
 * Ownership check shared by every `consumerKeys.*` entry point below —
 * `getAgentById` already scopes to `resolveOwnerId()` (see
 * `agents-logic.ts`), so a cross-tenant `agentId` simply won't resolve. Same
 * `ORPCError("NOT_FOUND")` shape `sessions-logic.ts`'s
 * `resolveConnectionForNewSession`/`resolveConnectionForExistingSession`
 * already use for the identical "caller-supplied agentId that isn't
 * theirs" case — reusing it here rather than inventing a second one.
 */
async function assertOwnsAgent(db: Database, agentId: string): Promise<void> {
  const agent = await getAgentById(db, agentId);
  if (!agent) {
    throw new ORPCError("NOT_FOUND", { message: `No agent registered with id "${agentId}".` });
  }
}

/**
 * The credential minted for external ACP consumers — see
 * `consumer-api-keys.ts`'s doc comment for why this is its own table rather
 * than a new `acprouter_agent_credentials.kind`. `ack_` prefix distinguishes
 * it at a glance from an enrollment token (`acp_`) or a machine/agent id —
 * same "prefix says what it's for" convention as this file's own
 * `mintEnrollmentToken`.
 */
function generateRawConsumerKey(): string {
  return `ack_${randomBytes(24).toString("hex")}`;
}

function toConsumerApiKeyVO(row: typeof acprouterConsumerApiKeys.$inferSelect): ConsumerApiKeyVO {
  return {
    id: row.id,
    agentId: row.agentId,
    label: row.label,
    createdAt: row.createdAt.toISOString(),
    lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
    revokedAt: row.revokedAt?.toISOString() ?? null,
  };
}

export async function listConsumerApiKeys(
  db: Database,
  agentId: string,
): Promise<ConsumerApiKeyVO[]> {
  await assertOwnsAgent(db, agentId);
  const rows = await db
    .select()
    .from(acprouterConsumerApiKeys)
    .where(eq(acprouterConsumerApiKeys.agentId, agentId))
    .orderBy(desc(acprouterConsumerApiKeys.createdAt));
  return rows.map(toConsumerApiKeyVO);
}

/**
 * Mints and persists a real, opaque, revocable consumer API key — surfaced
 * ONCE (the "Copy connection info" dashboard affordance), exactly like
 * `mintEnrollmentToken`'s command: the raw value never round-trips back from
 * `list`, only `keyHash` (never the raw key) is stored.
 *
 * Locks the agent row with `FOR UPDATE` inside the same transaction as the
 * insert, rather than only checking ownership before it — `removeAgent`
 * takes the same row lock for its soft-delete + key-revocation. Without
 * this, a mint racing a removal could read the agent as live, lose the
 * race, and insert its key after `removeAgent`'s revocation sweep already
 * ran, leaving a key for a removed agent that nothing ever revokes. The
 * lock makes the two operations serialize: whichever commits first is the
 * one the other sees.
 */
export async function mintConsumerApiKey(
  db: Database,
  agentId: string,
  label: string | undefined,
  serverOrigin: string,
): Promise<MintConsumerApiKeyOutput> {
  await assertOwnsAgent(db, agentId);

  const id = generateNanoID("cak_");
  const rawKey = generateRawConsumerKey();

  const row = await db.transaction(async (tx) => {
    const [agent] = await tx
      .select({ id: acprouterAgents.id })
      .from(acprouterAgents)
      .where(and(eq(acprouterAgents.id, agentId), isNull(acprouterAgents.deletedAt)))
      .for("update");
    if (!agent) {
      throw new ORPCError("NOT_FOUND", { message: `No agent registered with id "${agentId}".` });
    }

    const [inserted] = await tx
      .insert(acprouterConsumerApiKeys)
      .values({
        id,
        agentId,
        label: label ?? null,
        keyHash: hashToken(rawKey),
      })
      .returning();
    return inserted;
  });
  if (!row) {
    throw new Error("Minted a consumer API key but could not read it back.");
  }

  return {
    key: toConsumerApiKeyVO(row),
    rawKey,
    connectionUrl: buildConsumerConnectionUrl(serverOrigin, agentId),
  };
}

/**
 * Soft-revoke — `revokedAt`, never a delete, so a since-revoked key's
 * existence (and what it was ever able to reach) stays auditable. Atomic
 * `WHERE revokedAt IS NULL` guard, same "no read-then-write race" shape as
 * `redeemEnrollmentToken`'s `usedAt` check.
 *
 * Takes only the key's own `id` (no `agentId` — the dashboard's revoke
 * button has no reason to know or send one), so the ownership check has to
 * look the row up FIRST to learn which agent it belongs to, then verify
 * `getAgentById` resolves it for the caller. Deliberately throws the exact
 * same `NOT_FOUND` for "no such key" and "key exists but belongs to another
 * tenant" — distinguishing them in the error would leak whether a given key
 * id exists at all for a tenant that isn't the caller, the same
 * non-leaking posture `session-events-logic.ts`'s `listSessionEvents` uses.
 */
export async function revokeConsumerApiKey(db: Database, id: string): Promise<{ ok: boolean }> {
  const [key] = await db
    .select({ agentId: acprouterConsumerApiKeys.agentId })
    .from(acprouterConsumerApiKeys)
    .where(eq(acprouterConsumerApiKeys.id, id))
    .limit(1);
  if (!key || !(await getAgentById(db, key.agentId))) {
    throw new ORPCError("NOT_FOUND", {
      message: `No consumer API key registered with id "${id}".`,
    });
  }

  const [updated] = await db
    .update(acprouterConsumerApiKeys)
    .set({ revokedAt: new Date() })
    .where(and(eq(acprouterConsumerApiKeys.id, id), isNull(acprouterConsumerApiKeys.revokedAt)))
    .returning();
  if (updated) {
    // Orchestrator review fix: this key may be bound to a still-live Busabase
    // enrollment-completion row (`registerConsumerKeyHash`'s binding) — that
    // row's own `revokedAt` is what the completion-scoped unique index
    // (`(grantId, enrollmentId) WHERE revoked_at IS NULL`) and
    // `resolveExistingCompletion`'s idempotent-retry check both key off, NOT
    // this key's `revokedAt`. Leaving it live after revoking the key it
    // points at would both wrongly resolve a stale completion retry as
    // `"already_registered"` (closed above, by `resolveExistingCompletion`'s
    // own now-added key-revoked check) AND permanently block a legitimate
    // fresh re-pairing for the same `(grantId, enrollmentId)` via that unique
    // index. Tombstone it here too, same as the grant-revocation cascade and
    // abandoned-completion cleanup already do when THEY revoke a key.
    await db
      .update(acprouterEnrollmentCompletions)
      .set({ revokedAt: new Date() })
      .where(
        and(
          eq(acprouterEnrollmentCompletions.consumerKeyId, id),
          isNull(acprouterEnrollmentCompletions.revokedAt),
        ),
      );
    closeConsumerAcpConnection(id, "Consumer API key revoked");
  }
  return { ok: Boolean(updated) };
}

/**
 * Validates a raw bearer credential against a specific `?agentId=` — called
 * from the WS route's auth resolution (`resolveConsumerAcpAuth`), before
 * anything else, but always asynchronously per the same-tick discipline
 * documented on `acceptMachineBridgeConnection` and this Router's own
 * `/api/acp` route: this function is safe to `await` because nothing calls
 * it before the WebSocket stream is already wired.
 *
 * Scoped to `agentId` (not "any key this Router ever minted") — a key minted
 * for agent A must never authenticate a connection to agent B, which is the
 * entire meaning of "per-agent, not Router-wide" from this table's doc
 * comment. `lastUsedAt` is updated best-effort, fire-and-forget, mirroring
 * `touchApiKeyLastRequest`'s posture in Buda's own `sk_...` auth path — never
 * allowed to fail or delay the yes/no answer this function exists to give.
 *
 * Deliberately kept returning a plain `boolean` — this is a long-exported
 * `@acprouter/core` public API point, and legacy/shared callers outside this
 * module (OSS, other packages) depend on that exact shape. Codex interim
 * review blocker 2's long-lived-connection registry needs the matched key's
 * own `id`, not just a yes/no — rather than widen this function's return
 * type and risk breaking every existing caller, that need is served by the
 * new `resolveConsumerApiKeyId` below, a second, additive entry point.
 *
 * Joins against `acprouterAgents` for `deletedAt IS NULL`, not just this
 * key's own `revokedAt` — `removeAgent` revokes every key it can see at
 * removal time, but a key minted during the race window between its own
 * ownership check and its insert (see `mintConsumerApiKey`) could in
 * principle land as unrevoked for a since-removed agent. The join makes a
 * removed agent's id unusable for auth regardless of any such key's
 * `revokedAt` state. Not owner-scoped: an external ACP consumer has no
 * caller identity in this Router's own tenant model to scope against.
 */
export async function validateConsumerApiKey(
  db: Database,
  agentId: string,
  rawKey: string | null,
): Promise<boolean> {
  return (await resolveConsumerApiKeyId(db, agentId, rawKey)) !== null;
}

/**
 * The `keyId`-returning sibling of `validateConsumerApiKey` (Codex interim
 * review blocker 2) — same lookup, same scoping, same best-effort
 * `lastUsedAt` touch, but returns the matched key's own `id` instead of a
 * boolean. `consumer-acp-registry.ts`'s long-lived-connection tracking needs
 * this `id` to register and later revoke-close exactly the connection
 * authenticated by THIS key, not merely "some live connection for this
 * agent" (an agent can have multiple consumer keys, each independently
 * revocable). Added alongside `validateConsumerApiKey` rather than changing
 * that function's return shape, which would break its existing callers.
 */
export async function resolveConsumerApiKeyId(
  db: Database,
  agentId: string,
  rawKey: string | null,
): Promise<string | null> {
  if (!rawKey) return null;
  const keyHash = hashToken(rawKey);

  const [row] = await db
    .select({ id: acprouterConsumerApiKeys.id })
    .from(acprouterConsumerApiKeys)
    .innerJoin(acprouterAgents, eq(acprouterAgents.id, acprouterConsumerApiKeys.agentId))
    .where(
      and(
        eq(acprouterConsumerApiKeys.agentId, agentId),
        eq(acprouterConsumerApiKeys.keyHash, keyHash),
        isNull(acprouterConsumerApiKeys.revokedAt),
        isNull(acprouterAgents.deletedAt),
      ),
    )
    .limit(1);
  if (!row) return null;

  void db
    .update(acprouterConsumerApiKeys)
    .set({ lastUsedAt: new Date() })
    .where(eq(acprouterConsumerApiKeys.id, row.id))
    .catch((error: unknown) => {
      console.error(
        `[acprouter] failed to touch consumer key lastUsedAt id=${row.id}: ${String(error)}`,
      );
    });

  return row.id;
}

/**
 * Live-liveness re-check for an already-authenticated consumer connection
 * (Codex interim review blocker 2) — unlike `validateConsumerApiKey`, this
 * takes the key's OWN `id` directly (the connection already proved it once;
 * this just asks "is it still non-revoked right now"), with no hash
 * comparison. Used by the <=60s scheduler reconciliation sweep
 * (`reconcileConsumerAcpConnections`) to decide whether a long-lived
 * connection registered under this key must now be closed.
 */
export async function isConsumerApiKeyLive(db: Database, keyId: string): Promise<boolean> {
  const [row] = await db
    .select({ revokedAt: acprouterConsumerApiKeys.revokedAt })
    .from(acprouterConsumerApiKeys)
    .where(eq(acprouterConsumerApiKeys.id, keyId))
    .limit(1);
  return row !== undefined && row.revokedAt === null;
}

/**
 * Backstop sweep (Codex interim review blocker 2), run from the scheduler
 * tick, same cadence as `cleanupAbandonedEnrollmentCompletions`. Direct
 * `closeConsumerAcpConnection` calls at every revoke call site
 * (`revokeConsumerApiKey`, the grant-revocation cascade, abandoned-
 * completion cleanup, `revokeEnrollmentDevice`) already close a connection
 * the instant ITS OWN revoke happens — but only on the SAME process/pod that
 * executed that revoke, since `listConsumerAcpConnections()` reads a
 * `globalThis`-scoped, per-process registry (`consumer-acp-registry.ts`).
 * This sweep re-checks every connection CURRENTLY REGISTERED ON THIS PROCESS
 * against the DB and closes any that turn out to already be revoked.
 *
 * Honest scope (do not overclaim a cross-replica bound from this function
 * alone — see `scheduler/tick/route.ts`'s doc comment for the full
 * single-process-vs-multi-host analysis): within the process that performed
 * a revoke, closing is immediate (no sweep needed). Within a *different*
 * process that is holding the long-lived connection, this sweep is what
 * eventually closes it — but only once THIS sweep runs on THAT process. In
 * a single-replica deployment this still bounds staleness by the scheduler's
 * tick interval. In a multi-replica deployment where the scheduler tick is
 * invoked as a single HTTP call to a load-balanced Service (one pod per
 * invocation, not a fan-out to every pod), a connection held by a pod that
 * doesn't happen to receive that tick is not reconciled by this mechanism at
 * all. Cloud therefore independently installs per-socket authorization
 * leases on every process; those leases check actual grant membership and
 * enforce the no-poll bound without depending on this optional sweep.
 */
export async function reconcileConsumerAcpConnections(
  db: Database,
): Promise<{ closedKeyIds: string[] }> {
  const closedKeyIds: string[] = [];
  for (const [keyId] of listConsumerAcpConnections()) {
    const live = await isConsumerApiKeyLive(db, keyId);
    if (!live) {
      closeConsumerAcpConnection(keyId, "Consumer API key no longer live");
      closedKeyIds.push(keyId);
    }
  }
  return { closedKeyIds };
}

export type RegisterConsumerKeyHashResult =
  | {
      outcome: "registered" | "already_registered";
      key: ConsumerApiKeyVO;
      agentId: string;
      connectionUrl: string;
    }
  | { outcome: "rejected"; reason: "agent_not_ready" | "hash_mismatch" };

/** Postgres `unique_violation` — see `record-ops.ts`'s identical helper in
 * busabase-core for why both the direct `.code` and the drizzle-wrapped
 * `.cause.code` must be checked. */
function isUniqueViolation(error: unknown): boolean {
  const directCode = (error as { code?: unknown } | null | undefined)?.code;
  if (directCode === "23505") return true;
  const causeCode = (error as { cause?: { code?: unknown } } | null | undefined)?.cause?.code;
  return causeCode === "23505";
}

/** Loads the live completion for `(grantId, enrollmentId)` plus its bound key, and resolves the idempotent-retry/hash-mismatch verdict against `consumerKeyHash` — the shared tail end of both the fast (no-race) path and the post-conflict re-read after losing an insert race. */
async function resolveExistingCompletion(
  db: Database,
  grantId: string,
  enrollmentId: string,
  consumerKeyHash: string,
  serverOrigin: string,
): Promise<RegisterConsumerKeyHashResult | null> {
  const [existingCompletion] = await db
    .select()
    .from(acprouterEnrollmentCompletions)
    .where(
      and(
        eq(acprouterEnrollmentCompletions.grantId, grantId),
        eq(acprouterEnrollmentCompletions.enrollmentId, enrollmentId),
      ),
    )
    .limit(1);
  if (!existingCompletion) return null;
  if (existingCompletion.revokedAt) return { outcome: "rejected", reason: "agent_not_ready" };

  const [existingKey] = await db
    .select()
    .from(acprouterConsumerApiKeys)
    .where(eq(acprouterConsumerApiKeys.id, existingCompletion.consumerKeyId))
    .limit(1);
  // Orchestrator review fix: the completion row's own `revokedAt` can lag
  // behind its key's — `revokeConsumerApiKey` (a standalone key revoke, e.g.
  // from the dashboard) only ever touches `acprouterConsumerApiKeys`, never
  // the sibling completion row. Without this check, a revoked key with a
  // still-live completion row would be silently returned as
  // `"already_registered"` — i.e. a revoke could be undone by nothing more
  // than Busabase's own idempotent retry of a completion call it already
  // made once. A missing/revoked key is "no live binding here" exactly like
  // a missing completion is: fall through to the fresh-registration path
  // below rather than resolving it as a hash mismatch (the hash isn't
  // wrong — the binding is simply gone).
  if (!existingKey || existingKey.revokedAt !== null)
    return { outcome: "rejected", reason: "agent_not_ready" };
  if (existingKey.keyHash !== consumerKeyHash) {
    return { outcome: "rejected", reason: "hash_mismatch" };
  }
  return {
    outcome: "already_registered",
    key: toConsumerApiKeyVO(existingKey),
    agentId: existingCompletion.agentId,
    connectionUrl: buildConsumerConnectionUrl(serverOrigin, existingCompletion.agentId),
  };
}

/**
 * Grant-scoped idempotent consumer-key HASH registration (Task 5.2,
 * design.md Decision 7) — the "completion" step of OAuth-sourced enrollment.
 * Unlike `mintConsumerApiKey`, this never generates a raw secret: Busabase
 * generates and persists its own `ack_`-compatible secret, then calls this
 * with ONLY its SHA-256 digest. Router stores and equality-checks that
 * digest exactly as it would its own — the raw value never crosses this
 * boundary either way.
 *
 * Scoped by `(grantId, enrollmentId)` — both caller-independent (`grantId`
 * from the caller's own OAuth token, never trusted from the request body)
 * and required (`enrollmentId` is the request body's own field, same
 * documented `machineId` alias Task 4.4 established). Reuses
 * `getGrantEnrollmentStatus`'s exact `(id, grantId)` machine predicate so a
 * caller presenting a wrong or sibling `enrollmentId` is rejected the same
 * way that function already treats it — this function has no reason to
 * invent a second lookup shape.
 *
 * "Agent readiness" (Decision 7's own phrase, tightened per Codex interim
 * review blocker 4/the agent-readiness verification task) means TWO things,
 * both required: (1) `status === "connected"` on the `acprouterAgents` row —
 * a row merely existing (e.g. `disconnected`/`auth_required`/`error` from a
 * past session) is not readiness; (2) if the mint call recorded an
 * `intendedAgentSlug` on the enrollment token (Agent-selection, task #6), the
 * bridged agent's own reported `registrySlug` must match it exactly — a
 * mismatch (Busabase minted intending Codex, but the machine actually
 * bridged Claude) is rejected the same way as "not ready yet", never
 * silently registering a key against whichever agent happened to bridge.
 * A completion call that arrives before a real, matching, connected bridge
 * handshake gets `"agent_not_ready"`, a signal Busabase is expected to retry
 * on, not a trigger for this function to create a placeholder agent row
 * itself.
 *
 * Concurrency (Codex interim review blocker 3): two requests presenting the
 * SAME hash for the SAME `(grantId, enrollmentId)` at the same time can both
 * pass the up-front "no existing completion" read before either has
 * committed. The loser's `INSERT` then hits the partial unique index
 * (`acprouter_enrollment_completions_grant_enrollment_idx`) as a genuine
 * constraint violation, not a bug — this function catches that `23505`
 * specifically (never swallowing any other error) and re-resolves against
 * the winner's now-committed row, so the loser still gets a correct
 * `already_registered`/`hash_mismatch` verdict instead of an unhandled 500.
 */
export async function registerConsumerKeyHash(
  db: Database,
  grantId: string,
  enrollmentId: string,
  consumerKeyHash: string,
  serverOrigin: string,
): Promise<RegisterConsumerKeyHashResult> {
  const existing = await resolveExistingCompletion(
    db,
    grantId,
    enrollmentId,
    consumerKeyHash,
    serverOrigin,
  );
  if (existing) return existing;

  const [machineWithIntent] = await db
    .select({
      id: acprouterMachines.id,
      intendedAgentSlug: acprouterEnrollmentTokens.intendedAgentSlug,
    })
    .from(acprouterMachines)
    .innerJoin(acprouterEnrollmentTokens, eq(acprouterEnrollmentTokens.id, acprouterMachines.id))
    .where(and(eq(acprouterMachines.id, enrollmentId), eq(acprouterMachines.grantId, grantId)))
    .limit(1);
  if (!machineWithIntent) {
    return { outcome: "rejected", reason: "agent_not_ready" };
  }

  const agent = await getAgentByMachineId(db, machineWithIntent.id);
  if (!agent || agent.status !== "connected") {
    return { outcome: "rejected", reason: "agent_not_ready" };
  }
  if (
    machineWithIntent.intendedAgentSlug !== null &&
    agent.registrySlug !== machineWithIntent.intendedAgentSlug
  ) {
    return { outcome: "rejected", reason: "agent_not_ready" };
  }

  const keyId = generateNanoID("cak_");
  const completionId = generateNanoID("ecp_");
  try {
    await db.transaction(async (txDb) => {
      const [grant] = await txDb
        .select()
        .from(acprouterRouterEnrollmentGrants)
        .where(eq(acprouterRouterEnrollmentGrants.id, grantId))
        .for("update");
      const [token] = await txDb
        .select()
        .from(acprouterEnrollmentTokens)
        .where(eq(acprouterEnrollmentTokens.id, enrollmentId))
        .for("update");
      const [credential] = await txDb
        .select()
        .from(acprouterMachineBridgeCredentials)
        .where(eq(acprouterMachineBridgeCredentials.machineId, enrollmentId));
      if (!grant || grant.revokedAt || !token || !credential || credential.revokedAt)
        throw new ORPCError("FORBIDDEN", {
          message: "This pairing is no longer active. Start a new pairing.",
        });
      await txDb.insert(acprouterConsumerApiKeys).values({
        id: keyId,
        agentId: agent.id,
        keyHash: consumerKeyHash,
      });
      await txDb.insert(acprouterEnrollmentCompletions).values({
        id: completionId,
        grantId,
        enrollmentId,
        agentId: agent.id,
        consumerKeyId: keyId,
      });
    });
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    // Lost the race to a concurrent same-(grantId, enrollmentId) call that
    // committed first — re-resolve against ITS row, never retry our own
    // insert. The key we attempted above was rolled back with the
    // transaction, so there is nothing of ours left to clean up.
    const resolved = await resolveExistingCompletion(
      db,
      grantId,
      enrollmentId,
      consumerKeyHash,
      serverOrigin,
    );
    if (!resolved) {
      throw new Error(
        "registerConsumerKeyHash lost an insert race but found no winning completion row.",
      );
    }
    return resolved;
  }

  const [key] = await db
    .select()
    .from(acprouterConsumerApiKeys)
    .where(eq(acprouterConsumerApiKeys.id, keyId))
    .limit(1);
  if (!key) {
    throw new Error("Registered a consumer key hash but could not read it back.");
  }

  return {
    outcome: "registered",
    key: toConsumerApiKeyVO(key),
    agentId: agent.id,
    connectionUrl: buildConsumerConnectionUrl(serverOrigin, agent.id),
  };
}

function buildConsumerConnectionUrl(serverOrigin: string, agentId: string): string {
  const wsOrigin = serverOrigin.replace(/^http/, "ws");
  return `${wsOrigin}/api/acp?agentId=${agentId}`;
}

export type ActivateEnrollmentCompletionResult = { outcome: "activated" | "not_found" };

/**
 * Decision 7 / Codex interim review blocker 5's activation marker — called
 * by Busabase AFTER it has durably committed its own local vault entry for
 * the hash `registerConsumerKeyHash` registered. Deliberately idempotent:
 * calling this twice for the same `(grantId, enrollmentId)` is not an error,
 * it just leaves `activatedAt` set from the first call (the `WHERE
 * activatedAt IS NULL` guard makes the second call a no-op `UPDATE`, same
 * "no read-then-write race" shape `revokeConsumerApiKey` already uses). A
 * revoked completion (`revokedAt` set — e.g. by the cleanup sweep below, or
 * the grant-revocation cascade) can never be activated, by the same NOT NULL
 * exclusion used in the `.where()` below; it reports `"not_found"` exactly
 * like a completion that never existed, since both are "nothing live to
 * activate" from the caller's perspective.
 */
export async function activateEnrollmentCompletion(
  db: Database,
  grantId: string,
  enrollmentId: string,
): Promise<ActivateEnrollmentCompletionResult> {
  const [updated] = await db
    .update(acprouterEnrollmentCompletions)
    .set({ activatedAt: new Date() })
    .where(
      and(
        eq(acprouterEnrollmentCompletions.grantId, grantId),
        eq(acprouterEnrollmentCompletions.enrollmentId, enrollmentId),
        isNull(acprouterEnrollmentCompletions.revokedAt),
        isNull(acprouterEnrollmentCompletions.activatedAt),
        gt(acprouterEnrollmentCompletions.createdAt, new Date(Date.now() - 10 * 60 * 1000)),
      ),
    )
    .returning();
  if (updated) return { outcome: "activated" };

  const [existing] = await db
    .select({
      id: acprouterEnrollmentCompletions.id,
      activatedAt: acprouterEnrollmentCompletions.activatedAt,
    })
    .from(acprouterEnrollmentCompletions)
    .where(
      and(
        eq(acprouterEnrollmentCompletions.grantId, grantId),
        eq(acprouterEnrollmentCompletions.enrollmentId, enrollmentId),
        isNull(acprouterEnrollmentCompletions.revokedAt),
      ),
    )
    .limit(1);
  return existing?.activatedAt ? { outcome: "activated" } : { outcome: "not_found" };
}
