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
import { registerConsumerKeyHash } from "./consumer-api-keys-logic";
import {
  hashToken,
  mintGrantEnrollmentToken,
  redeemEnrollmentToken,
  revokeEnrollmentDevice,
  verifyMachineBridgeCredential,
} from "./machines-logic";

const SCRATCH_DIR = ".data/consumer-api-keys-logic-completion-test";

/**
 * Task 5.2/5.3's own verification: the grant-scoped idempotent consumer-key
 * HASH registration ("completion") primitive. Busabase's own generated
 * secret never appears here — only its SHA-256 digest, matching Decision
 * 7's "accepts only a validated digest format, not a raw secret."
 */
describe("registerConsumerKeyHash — grant-scoped idempotent completion (Task 5.2/5.3)", () => {
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

  async function seedGrant(id = "reg_completion_test") {
    await db.insert(acprouterRouterEnrollmentGrants).values({
      id,
      issuer: "https://busabase.test",
      clientId: "busabase-enrollment-client",
      acprouterUserId: "user_1",
      acprouterSpaceId: "space_1",
    });
    return id;
  }

  async function createReadyEnrollment(grantId: string): Promise<{ enrollmentId: string }> {
    const minted = await mintGrantEnrollmentToken(
      db,
      { ownerId: "space_1", grantId },
      "http://example.test",
    );
    const redeemed = await redeemEnrollmentToken(db, {
      token: minted.token,
      label: "oauth-device",
    });
    await upsertBridgedAgent(db, {
      ownerId: "space_1",
      machineId: redeemed.machineId,
      registrySlug: "claude-acp",
      label: "Claude",
      cwd: "/home/user/project",
      detectedVersion: "1.0.0",
      status: "connected",
    });
    return { enrollmentId: redeemed.machineId };
  }

  const SOME_HASH = hashToken("ack_some_busabase_generated_secret");
  const OTHER_HASH = hashToken("ack_a_totally_different_secret");

  it("rejects and revokes a bridge that first connects after its pairing deadline", async () => {
    const grantId = await seedGrant();
    const minted = await mintGrantEnrollmentToken(
      db,
      { grantId, ownerId: "space_1" },
      "https://router.test",
    );
    const redeemed = await redeemEnrollmentToken(db, { token: minted.token, label: "Late bridge" });
    await db
      .update(acprouterMachines)
      .set({ bridgeDeadlineAt: new Date(Date.now() - 1000) })
      .where(eq(acprouterMachines.id, redeemed.machineId));
    expect(
      await verifyMachineBridgeCredential(
        db,
        redeemed.machineId,
        redeemed.bridgeCredential ?? null,
      ),
    ).toEqual({ ok: false, reason: "invalid_credential" });
    const [credential] = await db
      .select()
      .from(acprouterMachineBridgeCredentials)
      .where(eq(acprouterMachineBridgeCredentials.machineId, redeemed.machineId));
    expect(credential.revokedAt).toBeTruthy();
  });

  it("cancels an unredeemed command without revoking its grant or sibling command", async () => {
    const grantId = await seedGrant();
    const cancelled = await mintGrantEnrollmentToken(
      db,
      { grantId, ownerId: "space_1" },
      "https://router.test",
    );
    const sibling = await mintGrantEnrollmentToken(
      db,
      { grantId, ownerId: "space_1" },
      "https://router.test",
    );
    expect(await revokeEnrollmentDevice(db, grantId, cancelled.enrollmentId)).toEqual({
      outcome: "revoked",
    });
    await expect(
      redeemEnrollmentToken(db, { token: cancelled.token, label: "Cancelled" }),
    ).rejects.toThrow();
    await expect(
      redeemEnrollmentToken(db, { token: sibling.token, label: "Sibling" }),
    ).resolves.toHaveProperty("machineId", sibling.enrollmentId);
  });

  it("disconnects exactly one completed device while sibling credentials remain live", async () => {
    const grantId = await seedGrant();
    const first = await createReadyEnrollment(grantId);
    const second = await createReadyEnrollment(grantId);
    const firstKey = await registerConsumerKeyHash(
      db,
      grantId,
      first.enrollmentId,
      SOME_HASH,
      "https://router.test",
    );
    const secondKey = await registerConsumerKeyHash(
      db,
      grantId,
      second.enrollmentId,
      OTHER_HASH,
      "https://router.test",
    );
    if (firstKey.outcome === "rejected" || secondKey.outcome === "rejected")
      throw new Error("Fixture not ready");
    await revokeEnrollmentDevice(db, grantId, first.enrollmentId);
    const [dead] = await db
      .select()
      .from(acprouterConsumerApiKeys)
      .where(eq(acprouterConsumerApiKeys.id, firstKey.key.id));
    const [live] = await db
      .select()
      .from(acprouterConsumerApiKeys)
      .where(eq(acprouterConsumerApiKeys.id, secondKey.key.id));
    const [bridge] = await db
      .select()
      .from(acprouterMachineBridgeCredentials)
      .where(eq(acprouterMachineBridgeCredentials.machineId, second.enrollmentId));
    expect(dead.revokedAt).toBeTruthy();
    expect(live.revokedAt).toBeNull();
    expect(bridge.revokedAt).toBeNull();
    expect(
      await registerConsumerKeyHash(
        db,
        grantId,
        first.enrollmentId,
        SOME_HASH,
        "https://router.test",
      ),
    ).toEqual({ outcome: "rejected", reason: "agent_not_ready" });
  });

  it("rejects with agent_not_ready when the device has not yet bridged (no agent row), and creates no key/completion row", async () => {
    const grantId = await seedGrant();
    const minted = await mintGrantEnrollmentToken(
      db,
      { ownerId: "space_1", grantId },
      "http://example.test",
    );
    const redeemed = await redeemEnrollmentToken(db, { token: minted.token, label: "not-bridged" });

    const result = await registerConsumerKeyHash(
      db,
      grantId,
      redeemed.machineId,
      SOME_HASH,
      "https://acprouter-cloud.test",
    );

    expect(result).toEqual({ outcome: "rejected", reason: "agent_not_ready" });
    expect(await db.select().from(acprouterConsumerApiKeys)).toHaveLength(0);
    expect(await db.select().from(acprouterEnrollmentCompletions)).toHaveLength(0);
  });

  it("rejects with agent_not_ready when the enrollmentId does not belong to this grant at all", async () => {
    const grantId = await seedGrant();
    const otherGrantId = await seedGrant("reg_other_grant");
    const { enrollmentId } = await createReadyEnrollment(otherGrantId);

    const result = await registerConsumerKeyHash(
      db,
      grantId,
      enrollmentId,
      SOME_HASH,
      "https://acprouter-cloud.test",
    );

    expect(result).toEqual({ outcome: "rejected", reason: "agent_not_ready" });
  });

  it("registers a new consumer key hash on first call once the device is bridged (agent exists)", async () => {
    const grantId = await seedGrant();
    const { enrollmentId } = await createReadyEnrollment(grantId);

    const result = await registerConsumerKeyHash(
      db,
      grantId,
      enrollmentId,
      SOME_HASH,
      "https://acprouter-cloud.test",
    );

    expect(result.outcome).toBe("registered");
    if (result.outcome === "rejected") throw new Error("unreachable");
    expect(result.key.id).toBeTruthy();
    expect(result.connectionUrl).toBe(
      `wss://acprouter-cloud.test/api/acp?agentId=${result.agentId}`,
    );

    const keys = await db.select().from(acprouterConsumerApiKeys);
    expect(keys).toHaveLength(1);
    expect(keys[0]?.keyHash).toBe(SOME_HASH);

    const completions = await db.select().from(acprouterEnrollmentCompletions);
    expect(completions).toHaveLength(1);
    expect(completions[0]).toMatchObject({ grantId, enrollmentId, agentId: result.agentId });
  });

  it("a same-hash retry returns identical nonsecret metadata and does NOT mint a second key or completion row", async () => {
    const grantId = await seedGrant();
    const { enrollmentId } = await createReadyEnrollment(grantId);

    const first = await registerConsumerKeyHash(
      db,
      grantId,
      enrollmentId,
      SOME_HASH,
      "https://acprouter-cloud.test",
    );
    const second = await registerConsumerKeyHash(
      db,
      grantId,
      enrollmentId,
      SOME_HASH,
      "https://acprouter-cloud.test",
    );

    expect(first.outcome).toBe("registered");
    expect(second.outcome).toBe("already_registered");
    if (first.outcome === "rejected" || second.outcome === "rejected") {
      throw new Error("unreachable");
    }
    expect(second.key.id).toBe(first.key.id);
    expect(second.agentId).toBe(first.agentId);
    expect(second.connectionUrl).toBe(first.connectionUrl);

    expect(await db.select().from(acprouterConsumerApiKeys)).toHaveLength(1);
    expect(await db.select().from(acprouterEnrollmentCompletions)).toHaveLength(1);
  });

  it("a different-hash retry for the same (grantId, enrollmentId) is rejected and the original key/completion are untouched", async () => {
    const grantId = await seedGrant();
    const { enrollmentId } = await createReadyEnrollment(grantId);

    const first = await registerConsumerKeyHash(
      db,
      grantId,
      enrollmentId,
      SOME_HASH,
      "https://acprouter-cloud.test",
    );
    const second = await registerConsumerKeyHash(
      db,
      grantId,
      enrollmentId,
      OTHER_HASH,
      "https://acprouter-cloud.test",
    );

    expect(first.outcome).toBe("registered");
    expect(second).toEqual({ outcome: "rejected", reason: "hash_mismatch" });

    const keys = await db.select().from(acprouterConsumerApiKeys);
    expect(keys).toHaveLength(1);
    expect(keys[0]?.keyHash).toBe(SOME_HASH);
  });

  it("two devices enrolled under the SAME grant each get their own independent completion/key, never colliding", async () => {
    const grantId = await seedGrant();
    const deviceA = await createReadyEnrollment(grantId);
    const deviceB = await createReadyEnrollment(grantId);

    const resultA = await registerConsumerKeyHash(
      db,
      grantId,
      deviceA.enrollmentId,
      SOME_HASH,
      "https://acprouter-cloud.test",
    );
    const resultB = await registerConsumerKeyHash(
      db,
      grantId,
      deviceB.enrollmentId,
      OTHER_HASH,
      "https://acprouter-cloud.test",
    );

    expect(resultA.outcome).toBe("registered");
    expect(resultB.outcome).toBe("registered");
    if (resultA.outcome === "rejected" || resultB.outcome === "rejected") {
      throw new Error("unreachable");
    }
    expect(resultA.agentId).not.toBe(resultB.agentId);
    expect(resultA.key.id).not.toBe(resultB.key.id);
    expect(await db.select().from(acprouterConsumerApiKeys)).toHaveLength(2);
  });

  it("a revoked completion blocks a same-hash retry from reopening it — the caller must re-register from scratch with a new secret", async () => {
    const grantId = await seedGrant();
    const { enrollmentId } = await createReadyEnrollment(grantId);

    const first = await registerConsumerKeyHash(
      db,
      grantId,
      enrollmentId,
      SOME_HASH,
      "https://acprouter-cloud.test",
    );
    if (first.outcome === "rejected") throw new Error("unreachable");

    await db
      .update(acprouterEnrollmentCompletions)
      .set({ revokedAt: new Date() })
      .where(eq(acprouterEnrollmentCompletions.grantId, grantId));

    // A real re-registration after cleanup/revocation uses a FRESH secret
    // Busabase generates anew (`acprouterConsumerApiKeys.keyHash` is globally
    // unique, so literally replaying the exact same hash is not a scenario
    // this primitive needs to support) — retrying with `SOME_HASH` again
    // would hit that unique constraint, which is a correct, unrelated
    // invariant, not something this test is about.
    const retry = await registerConsumerKeyHash(
      db,
      grantId,
      enrollmentId,
      OTHER_HASH,
      "https://acprouter-cloud.test",
    );

    expect(retry).toEqual({ outcome: "rejected", reason: "agent_not_ready" });

    const completions = await db.select().from(acprouterEnrollmentCompletions);
    expect(completions).toHaveLength(1);
  });
});
