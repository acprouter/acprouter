import { randomBytes } from "node:crypto";
import type { ConsumerApiKeyVO, MintConsumerApiKeyOutput } from "@acprouter/contract";
import { ORPCError } from "@orpc/server";
import { and, desc, eq, isNull } from "drizzle-orm";
import { generateNanoID } from "openlib/nanoid";
import type { Database } from "../../../db";
import { acprouterConsumerApiKeys } from "../../../db/schema";
import { getAgentById } from "./agents-logic";
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
 * The credential minted for external ACP consumers (spec §5.3 point 1, task
 * #14 — see `consumer-api-keys.ts`'s doc comment for why this is its own
 * table rather than a new `acprouter_agent_credentials.kind`). `ack_` prefix
 * distinguishes it at a glance from an enrollment token (`acp_`) or a
 * machine/agent id — same "prefix says what it's for" convention as this
 * file's own `mintEnrollmentToken`.
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

  await db.insert(acprouterConsumerApiKeys).values({
    id,
    agentId,
    label: label ?? null,
    keyHash: hashToken(rawKey),
  });

  const [row] = await db
    .select()
    .from(acprouterConsumerApiKeys)
    .where(eq(acprouterConsumerApiKeys.id, id))
    .limit(1);
  if (!row) {
    throw new Error("Minted a consumer API key but could not read it back.");
  }

  const wsOrigin = serverOrigin.replace(/^http/, "ws");
  return {
    key: toConsumerApiKeyVO(row),
    rawKey,
    connectionUrl: `${wsOrigin}/api/acp?agentId=${agentId}`,
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
  return { ok: Boolean(updated) };
}

/**
 * Validates a raw bearer credential against a specific `?agentId=` — called
 * from the WS route's auth resolution (`resolveConsumerAcpAuth`), BEFORE
 * anything else per the task brief, but always asynchronously per the
 * same-tick discipline documented on `acceptMachineBridgeConnection`
 * and this Router's own `/api/acp` route: this function is safe to
 * `await` because nothing calls it before the WebSocket stream is
 * already wired.
 *
 * Scoped to `agentId` (not "any key this Router ever minted") — a key minted
 * for agent A must never authenticate a connection to agent B, which is the
 * entire meaning of "per-agent, not Router-wide" from this table's doc
 * comment. `lastUsedAt` is updated best-effort, fire-and-forget, mirroring
 * `touchApiKeyLastRequest`'s posture in Buda's own `sk_...` auth path — never
 * allowed to fail or delay the yes/no answer this function exists to give.
 */
export async function validateConsumerApiKey(
  db: Database,
  agentId: string,
  rawKey: string | null,
): Promise<boolean> {
  if (!rawKey) return false;
  const keyHash = hashToken(rawKey);

  const [row] = await db
    .select()
    .from(acprouterConsumerApiKeys)
    .where(
      and(
        eq(acprouterConsumerApiKeys.agentId, agentId),
        eq(acprouterConsumerApiKeys.keyHash, keyHash),
        isNull(acprouterConsumerApiKeys.revokedAt),
      ),
    )
    .limit(1);
  if (!row) return false;

  void db
    .update(acprouterConsumerApiKeys)
    .set({ lastUsedAt: new Date() })
    .where(eq(acprouterConsumerApiKeys.id, row.id))
    .catch((error: unknown) => {
      console.error(
        `[acprouter] failed to touch consumer key lastUsedAt id=${row.id}: ${String(error)}`,
      );
    });

  return true;
}
