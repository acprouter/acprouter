import { createHash, randomBytes } from "node:crypto";
import type {
  MachineVO,
  MintEnrollmentTokenInput,
  MintEnrollmentTokenOutput,
  RedeemEnrollmentTokenInput,
  RedeemEnrollmentTokenOutput,
} from "@acprouter/contract";
import { and, desc, eq, isNull } from "drizzle-orm";
import { generateNanoID } from "openlib/nanoid";
import { resolveOwnerId } from "../../../context";
import type { Database } from "../../../db";
import { acprouterEnrollmentTokens, acprouterMachines } from "../../../db/schema";

/** Tokens are single-use (spec §7/§8.1) — short enough to type, long enough not to guess. */
const ENROLLMENT_TOKEN_TTL_MS = 10 * 60 * 1000;

/**
 * Exported (task #14) so `consumer-api-keys-logic.ts` reuses the exact same
 * hashing approach for consumer API keys instead of inventing a second one —
 * both are "single opaque secret, verified by equality, never decrypted"
 * credentials, and this repo's own convention is to reuse, not
 * re-derive, an already-correct primitive like this one.
 */
export function hashToken(rawToken: string): string {
  return createHash("sha256").update(rawToken).digest("hex");
}

function generateRawToken(): string {
  // Not the nanoid alphabet — a plain hex token has no ambiguous characters
  // and copy-pastes cleanly out of a terminal or a dashboard code block.
  return `acp_${randomBytes(24).toString("hex")}`;
}

function toMachineVO(row: typeof acprouterMachines.$inferSelect): MachineVO {
  return {
    id: row.id,
    label: row.label,
    platform: row.platform,
    cliVersion: row.cliVersion,
    status: row.status,
    lastSeenAt: row.lastSeenAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

export async function listMachines(db: Database): Promise<MachineVO[]> {
  const rows = await db
    .select()
    .from(acprouterMachines)
    .where(eq(acprouterMachines.ownerId, resolveOwnerId()))
    .orderBy(desc(acprouterMachines.createdAt));
  return rows.map(toMachineVO);
}

/**
 * Cheap existence check used by the bridge WS route (task #7) to reject an
 * unrecognized `machineId` before doing any ACP handshake with it — a
 * machine authenticates itself with the id its own successful `redeem` call
 * returned (spec §8.1's no-login trust model), so a `machineId` that isn't a
 * real row is either a stale/deleted machine or someone guessing.
 */
export async function machineExists(db: Database, machineId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: acprouterMachines.id })
    .from(acprouterMachines)
    .where(eq(acprouterMachines.id, machineId))
    .limit(1);
  return Boolean(row);
}

/**
 * The machine's OWN stored ownerId (set at redeem time from the enrollment
 * token that created it) — used by the bridge WS route to correctly attribute
 * anything the bridge writes (e.g. a newly-detected agent row) without ever
 * consulting resolveOwnerId(), since the machine dials in with no
 * session/actor context of its own (spec §8.1's no-login trust model).
 */
export async function getMachineOwnerId(
  db: Database,
  machineId: string,
): Promise<string | undefined> {
  const [row] = await db
    .select({ ownerId: acprouterMachines.ownerId })
    .from(acprouterMachines)
    .where(eq(acprouterMachines.id, machineId))
    .limit(1);
  return row?.ownerId;
}

/**
 * Flips a machine to online once its bridge socket completes a real ACP
 * `initialize` handshake (task #7) — this is what makes `status` in
 * `machines.list` mean "the bridge is actually connected right now" instead
 * of task #5's "was online at redeem time and never updated since".
 */
export async function markMachineOnline(db: Database, machineId: string): Promise<void> {
  await db
    .update(acprouterMachines)
    .set({ status: "online", lastSeenAt: new Date() })
    .where(eq(acprouterMachines.id, machineId));
}

/**
 * Flips a machine back to offline on socket close/error. Never throws over a
 * missing row — this runs from a socket-close handler with nothing useful to
 * do if the machine was deleted mid-connection.
 */
export async function markMachineOffline(db: Database, machineId: string): Promise<void> {
  await db
    .update(acprouterMachines)
    .set({ status: "offline" })
    .where(eq(acprouterMachines.id, machineId));
}

/**
 * Mints a single-use enrollment token and pre-allocates the future machine's
 * id (the token's own id) — the dashboard needs to know, up front, which
 * `machines` row to poll for once the CLI redeems it, and this avoids
 * inventing a second correlation id.
 */
export async function mintEnrollmentToken(
  db: Database,
  input: MintEnrollmentTokenInput,
  serverOrigin: string,
): Promise<MintEnrollmentTokenOutput> {
  const id = generateNanoID("ent_");
  const rawToken = generateRawToken();
  const expiresAt = new Date(Date.now() + ENROLLMENT_TOKEN_TTL_MS);

  await db.insert(acprouterEnrollmentTokens).values({
    id,
    ownerId: resolveOwnerId(),
    tokenHash: hashToken(rawToken),
    intendedAgentSlug: input.intendedAgentSlug ?? null,
    expiresAt,
  });

  return {
    machineId: id,
    token: rawToken,
    command: `npx @acprouter/cli connect --server ${serverOrigin} --token ${rawToken}`,
    expiresAt: expiresAt.toISOString(),
  };
}

export class RedeemEnrollmentTokenError extends Error {
  constructor(
    public readonly code: "invalid_token" | "expired" | "already_used",
    message: string,
  ) {
    super(message);
  }
}

/**
 * Redeems a one-time enrollment token, atomically. The `usedAt IS NULL`
 * guard in the `UPDATE ... WHERE` clause (not a separate read-then-write) is
 * what makes this safe against two concurrent redemptions of the same raw
 * token racing each other — only one `UPDATE` can match the row.
 */
export async function redeemEnrollmentToken(
  db: Database,
  input: RedeemEnrollmentTokenInput,
): Promise<RedeemEnrollmentTokenOutput> {
  const tokenHash = hashToken(input.token);

  const [tokenRow] = await db
    .select()
    .from(acprouterEnrollmentTokens)
    .where(eq(acprouterEnrollmentTokens.tokenHash, tokenHash))
    .limit(1);

  if (!tokenRow) {
    throw new RedeemEnrollmentTokenError(
      "invalid_token",
      "This enrollment token is not recognized.",
    );
  }
  if (tokenRow.usedAt) {
    throw new RedeemEnrollmentTokenError(
      "already_used",
      "This enrollment token has already been used. Mint a new one from the dashboard.",
    );
  }
  if (tokenRow.expiresAt.getTime() < Date.now()) {
    throw new RedeemEnrollmentTokenError(
      "expired",
      "This enrollment token has expired. Mint a new one from the dashboard.",
    );
  }

  const [claimed] = await db
    .update(acprouterEnrollmentTokens)
    .set({ usedAt: new Date() })
    .where(
      and(eq(acprouterEnrollmentTokens.id, tokenRow.id), isNull(acprouterEnrollmentTokens.usedAt)),
    )
    .returning();

  if (!claimed) {
    // Lost a race to a concurrent redemption of the same token between the
    // read above and this UPDATE — the other caller's UPDATE matched first.
    throw new RedeemEnrollmentTokenError(
      "already_used",
      "This enrollment token has already been used. Mint a new one from the dashboard.",
    );
  }

  await db.insert(acprouterMachines).values({
    id: tokenRow.id,
    // The token's OWN stored ownerId (set at mint time by a real actor via
    // the dashboard), not resolveOwnerId() — this function runs from the
    // CLI's bare HTTP POST, with no session/actor context of its own. For
    // the OSS single-owner edition both resolve to the same value either
    // way; for a multi-tenant host, ambient resolveOwnerId() here would
    // silently misattribute every redeemed machine, since there IS no
    // ambient actor at redeem time.
    ownerId: claimed.ownerId,
    label: input.label ?? "New machine",
    tunnelId: tokenRow.id,
    platform: input.platform ?? null,
    cliVersion: input.cliVersion ?? null,
    lastSeenAt: new Date(),
    status: "online",
  });

  return { machineId: tokenRow.id, intendedAgentSlug: tokenRow.intendedAgentSlug };
}
