import { rmSync } from "node:fs";
import path from "node:path";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { type Database, getDb } from "../../../db";
import {
  acprouterAgents,
  acprouterConsumerApiKeys,
  acprouterEnrollmentCompletions,
  acprouterEnrollmentTokens,
  acprouterMachineBridgeCredentials,
  acprouterMachines,
  acprouterRouterEnrollmentGrants,
} from "../../../db/schema";
import { upsertBridgedAgent } from "./agents-logic";
import { activateEnrollmentCompletion, registerConsumerKeyHash } from "./consumer-api-keys-logic";
import {
  cleanupAbandonedEnrollmentCompletions,
  hashToken,
  mintGrantEnrollmentToken,
  redeemEnrollmentToken,
} from "./machines-logic";

const SCRATCH_DIR = ".data/machines-logic-cleanup-test";

/**
 * Task 5.3's abandoned-completion cleanup (Codex interim review blocker 5
 * correction) — a device can register a consumer key hash after bridging
 * once, but if Busabase never calls back the activation endpoint
 * (`activateEnrollmentCompletion`) within 10 minutes, the completion is
 * considered abandoned REGARDLESS of the machine's own bridge state. This is
 * deliberately independent of `bridgeConnectedAt`/`bridgeDeadlineAt` (the
 * machine's own "never bridged in time" 2-minute deadline, which
 * `getGrantEnrollmentStatus` already reports separately as `state:
 * "failed"`) — the two conditions must never be conflated.
 */
describe("cleanupAbandonedEnrollmentCompletions — Task 5.3 / Codex blocker 5", () => {
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
    await db.delete(acprouterEnrollmentCompletions);
    await db.delete(acprouterConsumerApiKeys);
    await db.delete(acprouterAgents);
    await db.delete(acprouterMachineBridgeCredentials);
    await db.delete(acprouterMachines);
    await db.delete(acprouterEnrollmentTokens);
    await db.delete(acprouterRouterEnrollmentGrants);
  });

  let grantCounter = 0;
  async function seedGrant() {
    grantCounter += 1;
    const id = `grant_cleanup_${grantCounter}`;
    await db.insert(acprouterRouterEnrollmentGrants).values({
      id,
      issuer: "https://busabase.test",
      clientId: "busabase-enrollment-client",
      acprouterUserId: "user_1",
      acprouterSpaceId: "space_1",
    });
    return id;
  }

  async function createCompletedEnrollment(grantId: string, hash: string) {
    const minted = await mintGrantEnrollmentToken(
      db,
      { ownerId: "space_1", grantId },
      "http://example.test",
    );
    const redeemed = await redeemEnrollmentToken(db, { token: minted.token, label: "device" });
    await upsertBridgedAgent(db, {
      ownerId: "space_1",
      machineId: redeemed.machineId,
      registrySlug: "claude-acp",
      label: "Claude",
      cwd: "/home/user/project",
      detectedVersion: "1.0.0",
      status: "connected",
    });
    const result = await registerConsumerKeyHash(
      db,
      grantId,
      redeemed.machineId,
      hash,
      "https://acprouter-cloud.test",
    );
    if (result.outcome === "rejected") throw new Error("expected registration to succeed");
    return { machineId: redeemed.machineId, keyId: result.key.id };
  }

  /** Backdates `createdAt` past the 10-minute activation deadline — the
   *  real passage of time isn't exercised in a unit test, so the completion
   *  row's own `createdAt` is forced into the past instead. */
  async function backdateCompletion(machineId: string, msAgo: number) {
    await db
      .update(acprouterEnrollmentCompletions)
      .set({ createdAt: new Date(Date.now() - msAgo) })
      .where(eq(acprouterEnrollmentCompletions.enrollmentId, machineId));
  }

  it("cleans up a registered completion that was never activated within 10 minutes, even though the machine bridged fine", async () => {
    const grantId = await seedGrant();
    const { machineId, keyId } = await createCompletedEnrollment(
      grantId,
      hashToken("ack_abandoned_secret"),
    );
    // The device bridged successfully — this must NOT exempt it. Only
    // `activatedAt` exempts a completion from this cleanup.
    await db
      .update(acprouterMachines)
      .set({ bridgeConnectedAt: new Date() })
      .where(eq(acprouterMachines.id, machineId));
    await backdateCompletion(machineId, 11 * 60 * 1000);

    const result = await cleanupAbandonedEnrollmentCompletions(db);
    expect(result.cleanedCompletionIds).toHaveLength(1);

    const [key] = await db
      .select()
      .from(acprouterConsumerApiKeys)
      .where(eq(acprouterConsumerApiKeys.id, keyId));
    expect(key?.revokedAt).toBeTruthy();

    const [credential] = await db
      .select()
      .from(acprouterMachineBridgeCredentials)
      .where(eq(acprouterMachineBridgeCredentials.machineId, machineId));
    expect(credential?.revokedAt).toBeTruthy();

    const [completion] = await db
      .select()
      .from(acprouterEnrollmentCompletions)
      .where(eq(acprouterEnrollmentCompletions.enrollmentId, machineId));
    // Tombstoned, not deleted.
    expect(completion).toBeTruthy();
    expect(completion?.revokedAt).toBeTruthy();
  });

  it("does not touch a completion still within its 10-minute activation window", async () => {
    const grantId = await seedGrant();
    const { keyId } = await createCompletedEnrollment(grantId, hashToken("ack_fresh_secret"));

    const result = await cleanupAbandonedEnrollmentCompletions(db);
    expect(result.cleanedCompletionIds).toHaveLength(0);

    const [key] = await db
      .select()
      .from(acprouterConsumerApiKeys)
      .where(eq(acprouterConsumerApiKeys.id, keyId));
    expect(key?.revokedAt).toBeNull();
  });

  it("does not touch a completion that was activated, no matter how long ago it was created", async () => {
    const grantId = await seedGrant();
    const { machineId, keyId } = await createCompletedEnrollment(
      grantId,
      hashToken("ack_activated_secret"),
    );
    await backdateCompletion(machineId, 11 * 60 * 1000);
    await db
      .update(acprouterEnrollmentCompletions)
      .set({ activatedAt: new Date() })
      .where(eq(acprouterEnrollmentCompletions.enrollmentId, machineId));

    const result = await cleanupAbandonedEnrollmentCompletions(db);
    expect(result.cleanedCompletionIds).toHaveLength(0);

    const [key] = await db
      .select()
      .from(acprouterConsumerApiKeys)
      .where(eq(acprouterConsumerApiKeys.id, keyId));
    expect(key?.revokedAt).toBeNull();
  });

  it("re-running cleanup is a no-op for already-tombstoned completions", async () => {
    const grantId = await seedGrant();
    const { machineId } = await createCompletedEnrollment(
      grantId,
      hashToken("ack_abandoned_secret_2"),
    );
    await backdateCompletion(machineId, 11 * 60 * 1000);

    const first = await cleanupAbandonedEnrollmentCompletions(db);
    expect(first.cleanedCompletionIds).toHaveLength(1);

    const second = await cleanupAbandonedEnrollmentCompletions(db);
    expect(second.cleanedCompletionIds).toHaveLength(0);
  });

  /**
   * Orchestrator review blocker 1: the cleanup's up-front candidate SELECT is
   * a snapshot (`activatedAt IS NULL AND createdAt < cutoff`). If activation
   * commits in the window between that SELECT and the per-row transaction
   * actually running — simulated here by setting `activatedAt` directly on
   * the row right after it's been selected as a stale candidate, before
   * cleanup's transaction executes — the transaction's own re-check
   * (`isNull(activatedAt)` on the tombstone UPDATE, not just
   * `isNull(revokedAt)`) must lose the claim and leave the key, bridge
   * credential, and `activatedAt` completely untouched. Without that
   * re-check, this would revoke a connection that is now legitimately
   * active — exactly the bug this test pins.
   */
  it("preserves an activation that races in between the candidate scan and the cleanup transaction", async () => {
    const grantId = await seedGrant();
    const { machineId, keyId } = await createCompletedEnrollment(
      grantId,
      hashToken("ack_race_secret"),
    );
    await backdateCompletion(machineId, 11 * 60 * 1000);

    // Simulates the race: activation commits in the gap between cleanup's
    // own candidate SELECT and its per-row claim transaction.
    const originalTransaction = db.transaction.bind(db);
    const racingDb = new Proxy(db, {
      get(target, property) {
        if (property !== "transaction") return Reflect.get(target, property);
        return async (...args: Parameters<typeof db.transaction>) => {
          // Fault injection AFTER the candidate scan, immediately BEFORE its
          // transaction. Represent an activation already committed by a worker.
          await db
            .update(acprouterEnrollmentCompletions)
            .set({ activatedAt: new Date() })
            .where(eq(acprouterEnrollmentCompletions.enrollmentId, machineId));
          return Reflect.apply(originalTransaction, db, args);
        };
      },
    });
    const result = await cleanupAbandonedEnrollmentCompletions(racingDb);
    expect(result.cleanedCompletionIds).toHaveLength(0);

    const [key] = await db
      .select()
      .from(acprouterConsumerApiKeys)
      .where(eq(acprouterConsumerApiKeys.id, keyId));
    expect(key?.revokedAt).toBeNull();

    const [credential] = await db
      .select()
      .from(acprouterMachineBridgeCredentials)
      .where(eq(acprouterMachineBridgeCredentials.machineId, machineId));
    expect(credential?.revokedAt).toBeNull();

    const [completion] = await db
      .select()
      .from(acprouterEnrollmentCompletions)
      .where(eq(acprouterEnrollmentCompletions.enrollmentId, machineId));
    expect(completion?.activatedAt).toBeTruthy();
    expect(completion?.revokedAt).toBeNull();
  });

  it("rejects activation after the completion deadline instead of reviving an expired pairing", async () => {
    const grantId = await seedGrant();
    const { machineId } = await createCompletedEnrollment(grantId, hashToken("activation-expired"));
    await backdateCompletion(machineId, 11 * 60 * 1000);
    expect(await activateEnrollmentCompletion(db, grantId, machineId)).toEqual({
      outcome: "not_found",
    });
  });
});
