import { createHash, randomBytes } from "node:crypto";
import type {
  MachineVO,
  MintEnrollmentTokenInput,
  MintEnrollmentTokenOutput,
  RedeemEnrollmentTokenInput,
  RedeemEnrollmentTokenOutput,
} from "@acprouter/contract";
import { and, desc, eq, gt, isNull, lt } from "drizzle-orm";
import { generateNanoID } from "openlib/nanoid";
import { resolveOwnerId } from "../../../context";
import type { Database } from "../../../db";
import {
  acprouterConsumerApiKeys,
  acprouterEnrollmentCompletions,
  acprouterEnrollmentTokens,
  acprouterMachineBridgeCredentials,
  acprouterMachines,
} from "../../../db/schema";
import { closeConsumerAcpConnection } from "./consumer-acp-registry";
import { getMachineBridge, unregisterMachineBridge } from "./machine-bridge-registry";

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

export type BridgeCredentialCheckResult =
  | { ok: true }
  | { ok: false; reason: "unknown_machine" | "missing_credential" | "invalid_credential" };

/**
 * The bridge WS route's own gate (Task 5.1) — called BEFORE
 * `acceptMachineBridgeConnection`, since that function has no concept of a
 * bridge credential at all and must stay that way for `enrolledVia: "legacy"`
 * machines, whose trust model (spec §8.1) is unchanged: the `machineId`
 * itself, obtainable only from a successful `redeem` call, IS the credential.
 *
 * Only `enrolledVia: "oauth-enrollment"` machines require a credential at
 * all — a `"legacy"` machine with no `presentedCredential` passes with no
 * further check, exactly as before this task existed. An unrecognized
 * `machineId` is reported the same way `machineExists` already treats it
 * (not a credential problem specifically, since there is no machine to have
 * failed a credential check against).
 */
export async function verifyMachineBridgeCredential(
  db: Database,
  machineId: string,
  presentedCredential: string | null,
): Promise<BridgeCredentialCheckResult> {
  const [machine] = await db
    .select({
      enrolledVia: acprouterMachines.enrolledVia,
      grantId: acprouterMachines.grantId,
      bridgeConnectedAt: acprouterMachines.bridgeConnectedAt,
      bridgeDeadlineAt: acprouterMachines.bridgeDeadlineAt,
    })
    .from(acprouterMachines)
    .where(eq(acprouterMachines.id, machineId))
    .limit(1);

  if (!machine) {
    return { ok: false, reason: "unknown_machine" };
  }
  if (machine.enrolledVia === "legacy") {
    return { ok: true };
  }
  if (
    !machine.bridgeConnectedAt &&
    machine.bridgeDeadlineAt &&
    machine.bridgeDeadlineAt.getTime() <= Date.now()
  ) {
    if (machine.grantId) await revokeEnrollmentDevice(db, machine.grantId, machineId);
    return { ok: false, reason: "invalid_credential" };
  }

  if (!presentedCredential) {
    return { ok: false, reason: "missing_credential" };
  }

  const [credential] = await db
    .select({ revokedAt: acprouterMachineBridgeCredentials.revokedAt })
    .from(acprouterMachineBridgeCredentials)
    .where(
      and(
        eq(acprouterMachineBridgeCredentials.machineId, machineId),
        eq(acprouterMachineBridgeCredentials.credentialHash, hashToken(presentedCredential)),
      ),
    )
    .limit(1);

  if (!credential || credential.revokedAt) {
    return { ok: false, reason: "invalid_credential" };
  }

  return { ok: true };
}

/**
 * Flips a machine to online once its bridge socket completes a real ACP
 * `initialize` handshake (task #7) — this is what makes `status` in
 * `machines.list` mean "the bridge is actually connected right now" instead
 * of task #5's "was online at redeem time and never updated since".
 *
 * Also stamps `bridgeConnectedAt` the first time this happens for a given
 * machine (Task 4.5) — unlike `status`, which flips back to `"offline"` on
 * every disconnect, this is a one-time "has this machine EVER completed a
 * real handshake" marker the status endpoint uses to distinguish "still
 * waiting out its bridge-start deadline" from "connected at least once,
 * currently offline between sessions".
 */
export async function markMachineOnline(db: Database, machineId: string): Promise<void> {
  const [row] = await db
    .select({ bridgeConnectedAt: acprouterMachines.bridgeConnectedAt })
    .from(acprouterMachines)
    .where(eq(acprouterMachines.id, machineId))
    .limit(1);

  await db
    .update(acprouterMachines)
    .set({
      status: "online",
      lastSeenAt: new Date(),
      bridgeConnectedAt: row?.bridgeConnectedAt ?? new Date(),
    })
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
    enrollmentId: id,
    token: rawToken,
    command: `npx @acprouter/cli connect --server ${serverOrigin} --token ${rawToken}`,
    expiresAt: expiresAt.toISOString(),
  };
}

/**
 * Grant-scoped mint primitive (Task 4.2). Pure DB mechanics only — this
 * function does NOT re-run the live-membership-and-write-access check
 * itself. The host's membership guard queries `members`/`organizations`,
 * concepts that don't exist in the self-hosted single-owner model, so it
 * cannot live in this package.
 * The Cloud-side OAuth-bearer-authenticated mint route is the only intended
 * caller, and it is REQUIRED to re-run that check immediately before
 * calling this — this primitive trusts the `grantId`/`ownerId` it's handed
 * exactly as-is, the same trust boundary `redeemEnrollmentToken` already has
 * for the legacy path's `ownerId`.
 *
 * A single `grantId` can have this called multiple times — once per device
 * the grantee wants to enroll under the same authorization. Each call
 * returns its own distinct `enrollmentId` (`===` its own `machineId`), which
 * the caller must track per-device and pass back on every later
 * status/completion/cancel/disconnect call for THAT device — never reusing
 * one device's `enrollmentId` to address another's, and never falling back
 * to `grantId` alone once more than one device may exist under it.
 */
export async function mintGrantEnrollmentToken(
  db: Database,
  input: MintEnrollmentTokenInput & { ownerId: string; grantId: string },
  serverOrigin: string,
): Promise<MintEnrollmentTokenOutput> {
  const trustedOrigin = new URL(serverOrigin);
  if (
    !["https:", "http:"].includes(trustedOrigin.protocol) ||
    trustedOrigin.username ||
    trustedOrigin.password ||
    trustedOrigin.pathname !== "/" ||
    trustedOrigin.search ||
    trustedOrigin.hash
  ) {
    throw new Error("Router server must be a plain HTTP(S) origin.");
  }
  serverOrigin = trustedOrigin.origin;
  if (
    trustedOrigin.protocol !== "https:" &&
    process.env.NODE_ENV === "production" &&
    !["localhost", "127.0.0.1", "[::1]"].includes(trustedOrigin.hostname)
  ) {
    throw new Error("Cloud enrollment requires HTTPS outside local development.");
  }
  const id = generateNanoID("ent_");
  const rawToken = generateRawToken();
  const expiresAt = new Date(Date.now() + ENROLLMENT_TOKEN_TTL_MS);

  await db.insert(acprouterEnrollmentTokens).values({
    id,
    ownerId: input.ownerId,
    tokenHash: hashToken(rawToken),
    intendedAgentSlug: input.intendedAgentSlug ?? null,
    expiresAt,
    grantId: input.grantId,
  });

  return {
    machineId: id,
    enrollmentId: id,
    token: rawToken,
    command: `npx @acprouter/cli connect --server ${serverOrigin} --token ${rawToken}`,
    expiresAt: expiresAt.toISOString(),
  };
}

export class RedeemEnrollmentTokenError extends Error {
  constructor(
    public readonly code: "invalid_token" | "expired" | "already_used" | "grant_invalid",
    message: string,
  ) {
    super(message);
  }
}

function generateRawBridgeCredential(): string {
  return `abc_${randomBytes(24).toString("hex")}`;
}

/**
 * Re-verifies a `grantId`-carrying token's grant is still live/the grantee
 * still has write access, called immediately before the token is claimed
 * (Task 4.2 correction). `acprouter-core` has no native concept of
 * "members"/"organizations" — that's Cloud-only domain knowledge — so this
 * is a caller-supplied callback rather than a direct DB query here. Defaults
 * to an always-ok no-op so every existing/legacy call site (OSS's route,
 * and any caller that never mints grant-scoped tokens in the first place)
 * keeps behaving exactly as before; the one REQUIRED caller is Cloud's own
 * `/api/v1/machines/redeem` route, which MUST pass the real
 * `checkGrantMembershipAndWriteAccess` check here — a pre-check at the route
 * level is not enough, since the token's 10-minute TTL leaves a window for
 * the grant to be revoked or the role to be downgraded between mint and
 * redeem, and the atomic claim below is what makes checking here (inside
 * the same transaction attempt, right before the claim) actually matter
 * rather than being just another TOCTOU race.
 */
export type VerifyLiveGrantFn = (grantId: string) => Promise<boolean>;

const alwaysLiveGrant: VerifyLiveGrantFn = async () => true;

/**
 * Redeems a one-time enrollment token, atomically, then dispatches on the
 * token row's OWN stored `grantId` (never a caller-supplied flag — design.md:
 * "Cloud redeem handler dispatches by trusted stored token kind") to pick one
 * of two branches:
 *
 * - `grantId === null` (legacy): the pre-existing, UNCHANGED two-statement
 *   claim-then-insert (Task 4.3's regression requirement — this branch's
 *   behavior, including its lack of a transaction, is deliberately preserved
 *   exactly as it was before this function grew a second branch).
 * - `grantId !== null` (oauth-enrollment, Task 4.2): re-verifies the grant is
 *   still live (see `verifyLiveGrant` above) BEFORE attempting the claim —
 *   never relying on whatever was true at mint time — then the token claim
 *   UPDATE (same atomic `usedAt IS NULL AND expiresAt > now()` guard), the
 *   `acprouterMachines` INSERT (`enrolledVia: "oauth-enrollment"`, carrying
 *   the token's own `grantId`), and the new bridge-credential INSERT are all
 *   wrapped in one `db.transaction` — a failure anywhere inside rolls back
 *   the token claim too, so the token is NOT burned and remains re-redeemable
 *   (Task 4.2's explicit requirement), unlike the legacy branch's silently
 *   wasted-token failure mode.
 *
 * The not-found/already-used/expired checks run BEFORE either branch, from
 * one shared read — Task 4.2 requires an expired token be rejected "within
 * the same atomic guard, not a later separate check": the atomic guard here
 * is the `usedAt IS NULL` claim UPDATE common to both branches; the
 * `expiresAt` advisory check above it is what actually produces the
 * `expired` error code distinctly from `already_used`, and is checked prior
 * to attempting either branch's claim, so an expired token is never routed
 * into the transactional branch at all.
 */
export async function redeemEnrollmentToken(
  db: Database,
  input: RedeemEnrollmentTokenInput,
  verifyLiveGrant: VerifyLiveGrantFn = alwaysLiveGrant,
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

  if (tokenRow.grantId !== null) {
    return redeemGrantEnrollmentTokenTransactional(db, tokenRow, input, verifyLiveGrant);
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

  // Legacy (non-grant) path's response shape must stay byte-for-byte
  // identical to what it was before this feature existed — `bridgeCredential`
  // is omitted entirely here, never present as `null`.
  return {
    machineId: tokenRow.id,
    intendedAgentSlug: tokenRow.intendedAgentSlug,
  };
}

/** Independent of the enrollment token's own 10-minute TTL (Task 4.5) — governs how long a redeemed-but-not-yet-bridged machine has before it's reported `failed`. */
const BRIDGE_START_DEADLINE_MS = 2 * 60 * 1000;

async function redeemGrantEnrollmentTokenTransactional(
  db: Database,
  tokenRow: typeof acprouterEnrollmentTokens.$inferSelect,
  input: RedeemEnrollmentTokenInput,
  verifyLiveGrant: VerifyLiveGrantFn,
): Promise<RedeemEnrollmentTokenOutput> {
  const grantId = tokenRow.grantId;
  if (!grantId) throw new Error("redeemGrantEnrollmentTokenTransactional requires a grantId");

  // Re-check NOW, not just at mint time — the token's own 10-minute TTL
  // leaves a window for the grant to be revoked or the grantee's role to be
  // downgraded between mint and redeem. A stale "it was fine when minted"
  // is exactly what Task 4.2's correction forbids relying on.
  const grantStillLive = await verifyLiveGrant(grantId);
  if (!grantStillLive) {
    throw new RedeemEnrollmentTokenError(
      "grant_invalid",
      "The authorization behind this enrollment token is no longer valid.",
    );
  }

  const rawCredential = generateRawBridgeCredential();
  const credentialId = generateNanoID("mbc_");

  const result = await db.transaction(async (tx) => {
    const txDb = tx as unknown as Database;

    const [claimed] = await txDb
      .update(acprouterEnrollmentTokens)
      .set({ usedAt: new Date() })
      .where(
        and(
          eq(acprouterEnrollmentTokens.id, tokenRow.id),
          isNull(acprouterEnrollmentTokens.usedAt),
          gt(acprouterEnrollmentTokens.expiresAt, new Date()),
        ),
      )
      .returning();

    if (!claimed) return null;

    await txDb.insert(acprouterMachines).values({
      id: tokenRow.id,
      ownerId: claimed.ownerId,
      label: input.label ?? "New machine",
      tunnelId: tokenRow.id,
      platform: input.platform ?? null,
      cliVersion: input.cliVersion ?? null,
      lastSeenAt: new Date(),
      status: "online",
      enrolledVia: "oauth-enrollment",
      grantId,
      bridgeDeadlineAt: new Date(Date.now() + BRIDGE_START_DEADLINE_MS),
    });

    await txDb.insert(acprouterMachineBridgeCredentials).values({
      id: credentialId,
      machineId: tokenRow.id,
      credentialHash: hashToken(rawCredential),
    });

    return claimed;
  });

  if (!result) {
    // Lost a race to a concurrent redemption, OR expired between the
    // advisory check above and this transaction's own guard — either way,
    // the transaction rolled back cleanly (nothing partially created), and
    // this is reported the same way the legacy branch reports its own race
    // loss: `already_used`, since by the time we're here the advisory
    // not-expired check already passed once.
    throw new RedeemEnrollmentTokenError(
      "already_used",
      "This enrollment token has already been used. Mint a new one from the dashboard.",
    );
  }

  return {
    machineId: tokenRow.id,
    intendedAgentSlug: tokenRow.intendedAgentSlug,
    bridgeCredential: rawCredential,
  };
}

export type GrantEnrollmentStatus =
  | { state: "not_redeemed" }
  | { state: "redeemed_offline"; machineId: string }
  | { state: "online"; machineId: string }
  | { state: "failed"; machineId: string };

/**
 * The grant-scoped status endpoint's own view (Task 4.4). Scoped by BOTH
 * `grantId` AND `enrollmentId` — never `grantId` alone. The approved spec
 * allows multiple devices to be enrolled under the same grant (each mint
 * call under a still-live grant starts an independent pending enrollment),
 * so a `grantId`-only lookup would pick an arbitrary machine among
 * however many share that grant, which is wrong for two distinct reasons:
 * it can report the wrong device's state to the caller polling for a
 * SPECIFIC enrollment, and (more seriously) it lets one device's status
 * poll observe — and in the route layer, "complete" against — a different
 * device's machine row just because they happen to share a grantId.
 *
 * `enrollmentId` IS the mint response's own `machineId` (the token's id,
 * reused 1:1 as the eventual machine's id — see `mintGrantEnrollmentToken`'s
 * doc comment) — not a new, separate concept. The caller (Busabase, via the
 * status route) must have received this id back from its own mint call and
 * pass it on every subsequent status/completion/cancel/disconnect call for
 * that specific device; a value that isn't the exact id of an enrollment
 * token or machine created under THIS grantId is indistinguishable from
 * "not redeemed yet" and reported as such — intentionally: this function
 * must never leak the existence of (or status of) a sibling enrollment
 * under the same grant to a caller that got its `enrollmentId` wrong.
 *
 * Looks at the MACHINE row's own `bridgeConnectedAt`/`bridgeDeadlineAt`
 * (Task 4.5), not just `status` — `status` is set to `"online"` eagerly at
 * redeem time for both the legacy and oauth-enrollment paths (pre-existing
 * behavior, unchanged here), so it alone cannot distinguish "just redeemed,
 * still within its bridge-start deadline" from "has actually bridged at
 * least once".
 */
export async function getGrantEnrollmentStatus(
  db: Database,
  grantId: string,
  enrollmentId: string,
): Promise<GrantEnrollmentStatus> {
  const [machine] = await db
    .select()
    .from(acprouterMachines)
    .where(and(eq(acprouterMachines.id, enrollmentId), eq(acprouterMachines.grantId, grantId)))
    .limit(1);

  if (!machine) {
    // Either genuinely not redeemed yet (the token for this enrollmentId
    // still exists, unused, under this grant), or `enrollmentId` doesn't
    // belong to this grant at all (wrong id, or a sibling enrollment's id)
    // — both are reported identically, on purpose: this function must never
    // confirm or deny a sibling enrollment's existence to a caller presenting
    // the wrong id.
    return { state: "not_redeemed" };
  }

  if (!machine.bridgeConnectedAt) {
    const deadlinePassed =
      machine.bridgeDeadlineAt !== null && machine.bridgeDeadlineAt.getTime() < Date.now();
    if (deadlinePassed) {
      await revokeEnrollmentDevice(db, grantId, machine.id);
      return { state: "failed", machineId: machine.id };
    }
    return { state: "redeemed_offline", machineId: machine.id };
  }

  return machine.status === "online"
    ? { state: "online", machineId: machine.id }
    : { state: "redeemed_offline", machineId: machine.id };
}

/** Decision 7's independent registered-not-activated deadline — deliberately
 *  NOT `BRIDGE_START_DEADLINE_MS` (that one fires off `bridgeConnectedAt IS
 *  NULL`, a different failure: "never bridged at all"). This fires off
 *  `activatedAt IS NULL`, which can be true even for a machine that bridged
 *  successfully — Busabase registered the key hash but never came back to
 *  confirm it durably committed its own local vault entry. */
const COMPLETION_ACTIVATION_DEADLINE_MS = 10 * 60 * 1000;

/**
 * Task 5.3's abandoned-completion cleanup (Codex interim review blocker 5):
 * a completion row can sit forever in "registered but never activated" if
 * Busabase's `registerConsumerKeyHash` call succeeds but the client crashes
 * or loses its response before it durably persists the hash locally and
 * calls back the activation endpoint. This is checked purely against
 * `activatedAt IS NULL AND createdAt < now() - 10min` — independent of
 * `bridgeConnectedAt`/`bridgeDeadlineAt` (the machine may well be online and
 * bridged; that's irrelevant to whether BUSABASE ever confirmed activation).
 * Once `activatedAt` is set the completion is permanently exempt, no matter
 * how much time has passed since `createdAt` (see `enrollment-completions.ts`'s
 * schema doc comment).
 *
 * Revokes the derived consumer key and the machine's bridge credential, then
 * tombstones the completion row (`revokedAt`, never a delete — same
 * discipline as every other credential table here) so a fresh pairing can
 * be registered from scratch rather than silently reopening this one (Task
 * 5.3's own literal requirement).
 *
 * Orchestrator review fix: the initial SELECT above is a snapshot — if
 * `activateEnrollmentCompletion` races in and sets `activatedAt` between
 * that SELECT and this transaction running, naively revoking anyway would
 * kill a connection that is now legitimately active. So the tombstone claim
 * itself re-checks `activatedAt IS NULL` (not just `revokedAt IS NULL`) via
 * `.returning()`, INSIDE the same transaction as the key/bridge revokes —
 * the three updates are no longer independent "revoke anyway" steps, they
 * only happen at all if this claim actually wins. A `.returning()` miss here
 * means activation won the race, so the whole transaction is a no-op for
 * this row and nothing is revoked.
 */
export async function cleanupAbandonedEnrollmentCompletions(db: Database): Promise<{
  cleanedCompletionIds: string[];
}> {
  const expiredBridges = await db
    .select({ id: acprouterMachines.id, grantId: acprouterMachines.grantId })
    .from(acprouterMachines)
    .where(
      and(
        eq(acprouterMachines.enrolledVia, "oauth-enrollment"),
        isNull(acprouterMachines.bridgeConnectedAt),
        lt(acprouterMachines.bridgeDeadlineAt, new Date()),
      ),
    );
  for (const machine of expiredBridges) {
    if (machine.grantId) await revokeEnrollmentDevice(db, machine.grantId, machine.id);
  }
  const abandoned = await db
    .select({
      completionId: acprouterEnrollmentCompletions.id,
      consumerKeyId: acprouterEnrollmentCompletions.consumerKeyId,
      machineId: acprouterEnrollmentCompletions.enrollmentId,
    })
    .from(acprouterEnrollmentCompletions)
    .where(
      and(
        isNull(acprouterEnrollmentCompletions.revokedAt),
        isNull(acprouterEnrollmentCompletions.activatedAt),
        lt(
          acprouterEnrollmentCompletions.createdAt,
          new Date(Date.now() - COMPLETION_ACTIVATION_DEADLINE_MS),
        ),
      ),
    );

  const cleanedCompletionIds: string[] = [];
  for (const row of abandoned) {
    const claimed = await db.transaction(async (tx) => {
      const txDb = tx as unknown as Database;
      const [claimedRow] = await txDb
        .update(acprouterEnrollmentCompletions)
        .set({ revokedAt: new Date() })
        .where(
          and(
            eq(acprouterEnrollmentCompletions.id, row.completionId),
            isNull(acprouterEnrollmentCompletions.revokedAt),
            isNull(acprouterEnrollmentCompletions.activatedAt),
          ),
        )
        .returning();
      if (!claimedRow) return false;

      await txDb
        .update(acprouterConsumerApiKeys)
        .set({ revokedAt: new Date() })
        .where(
          and(
            eq(acprouterConsumerApiKeys.id, row.consumerKeyId),
            isNull(acprouterConsumerApiKeys.revokedAt),
          ),
        );
      await txDb
        .update(acprouterMachineBridgeCredentials)
        .set({ revokedAt: new Date() })
        .where(
          and(
            eq(acprouterMachineBridgeCredentials.machineId, row.machineId),
            isNull(acprouterMachineBridgeCredentials.revokedAt),
          ),
        );
      return true;
    });
    if (!claimed) continue;
    closeConsumerAcpConnection(row.consumerKeyId, "Enrollment completion abandoned");
    const bridge = getMachineBridge(row.machineId);
    if (bridge) {
      unregisterMachineBridge(row.machineId, bridge.connection);
      try {
        bridge.connection.close();
      } catch {
        /* Continue cleanup. */
      }
    }
    cleanedCompletionIds.push(row.completionId);
  }

  return { cleanedCompletionIds };
}

export type RevokeEnrollmentDeviceResult = { outcome: "revoked" | "not_found" };

/**
 * Device/enrollment-scoped revoke (post-draft review: `disconnectRouterConnection`
 * was calling `/api/oauth/revoke`, which revokes the ENTIRE grant/token — every
 * sibling device enrolled under the same grant would be torn down by a single
 * device's "disconnect" click). This function revokes exactly ONE device's
 * reachable credentials and leaves the grant, its OAuth token, and every OTHER
 * device enrolled under it untouched — the OAuth revoke endpoint remains the
 * tool for "remove the whole integration", this one is "remove this device".
 *
 * Scoped by `(grantId, enrollmentId)` — never by `enrollmentId` alone — so a
 * caller authenticated as grant A can never revoke a device that actually
 * belongs to grant B, mirroring every other grant-scoped lookup in this file
 * (`getGrantEnrollmentStatus`, `registerConsumerKeyHash`).
 *
 * Reuses the exact same atomic tombstone-then-cascade shape as
 * `cleanupAbandonedEnrollmentCompletions`: the completion row's `revokedAt IS
 * NULL` claim via `.returning()` happens inside the transaction, so a
 * concurrent activation or a concurrent second revoke call race safely —
 * only the winner of the claim proceeds to revoke the key/credential/socket.
 * Deliberately does NOT gate on `activatedAt` (unlike the abandonment sweep):
 * an explicit user-requested disconnect must revoke a live, activated
 * connection too, not just an abandoned pending one.
 */
export async function revokeEnrollmentDevice(
  db: Database,
  grantId: string,
  enrollmentId: string,
): Promise<RevokeEnrollmentDeviceResult> {
  // Lock the same token row used by redemption/completion. Cancellation must
  // work before redemption, before registration, and after activation alike.
  await db.transaction(async (tx) => {
    const [token] = await tx
      .select()
      .from(acprouterEnrollmentTokens)
      .where(
        and(
          eq(acprouterEnrollmentTokens.id, enrollmentId),
          eq(acprouterEnrollmentTokens.grantId, grantId),
        ),
      )
      .for("update");
    if (!token) return;
    await tx
      .update(acprouterEnrollmentTokens)
      .set({ usedAt: new Date() })
      .where(eq(acprouterEnrollmentTokens.id, enrollmentId));
    await tx
      .update(acprouterMachineBridgeCredentials)
      .set({ revokedAt: new Date() })
      .where(eq(acprouterMachineBridgeCredentials.machineId, enrollmentId));
  });
  const [ownedToken] = await db
    .select()
    .from(acprouterEnrollmentTokens)
    .where(
      and(
        eq(acprouterEnrollmentTokens.id, enrollmentId),
        eq(acprouterEnrollmentTokens.grantId, grantId),
      ),
    );
  if (!ownedToken) return { outcome: "not_found" };
  const existingBridge = getMachineBridge(enrollmentId);
  if (existingBridge) {
    unregisterMachineBridge(enrollmentId, existingBridge.connection);
    try {
      existingBridge.connection.close();
    } catch {
      /* Credentials remain revoked. */
    }
  }
  const [completion] = await db
    .select({
      id: acprouterEnrollmentCompletions.id,
      consumerKeyId: acprouterEnrollmentCompletions.consumerKeyId,
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
  if (!completion) return { outcome: "revoked" };

  const claimed = await db.transaction(async (tx) => {
    const txDb = tx as unknown as Database;
    const [claimedRow] = await txDb
      .update(acprouterEnrollmentCompletions)
      .set({ revokedAt: new Date() })
      .where(
        and(
          eq(acprouterEnrollmentCompletions.id, completion.id),
          isNull(acprouterEnrollmentCompletions.revokedAt),
        ),
      )
      .returning();
    if (!claimedRow) return false;

    await txDb
      .update(acprouterConsumerApiKeys)
      .set({ revokedAt: new Date() })
      .where(
        and(
          eq(acprouterConsumerApiKeys.id, completion.consumerKeyId),
          isNull(acprouterConsumerApiKeys.revokedAt),
        ),
      );
    await txDb
      .update(acprouterMachineBridgeCredentials)
      .set({ revokedAt: new Date() })
      .where(
        and(
          eq(acprouterMachineBridgeCredentials.machineId, enrollmentId),
          isNull(acprouterMachineBridgeCredentials.revokedAt),
        ),
      );
    return true;
  });
  if (!claimed) return { outcome: "not_found" };

  closeConsumerAcpConnection(completion.consumerKeyId, "Enrollment device disconnected");
  const bridge = getMachineBridge(enrollmentId);
  if (bridge) {
    unregisterMachineBridge(enrollmentId, bridge.connection);
    bridge.connection.close();
  }
  return { outcome: "revoked" };
}
