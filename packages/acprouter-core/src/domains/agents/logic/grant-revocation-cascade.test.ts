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
import { revokeRouterEnrollmentGrantCascadeCore } from "./grant-revocation-cascade-core";
import {
  getMachineBridge,
  registerMachineBridge,
  unregisterMachineBridge,
} from "./machine-bridge-registry";
import { hashToken, mintGrantEnrollmentToken, redeemEnrollmentToken } from "./machines-logic";

const SCRATCH_DIR = ".data/grant-revocation-cascade-core-test";

/**
 * Task 5.4's DB-only cascade steps, tested directly against
 * `@acprouter/core` (the task's own named test path). A host's OAuth/
 * `verifications` cleanup is layered on top of this and belongs in its
 * route-level test for the full, OAuth-inclusive cascade.
 */
describe("revokeRouterEnrollmentGrantCascadeCore — Task 5.4", () => {
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

  async function seedGrant(id: string) {
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

  it("revokes every consumer key, bridge credential, and pending token reachable from the grant, and closes any live bridge connection", async () => {
    const grantId = await seedGrant("grant_cascade_1");
    const { machineId, keyId } = await createCompletedEnrollment(
      grantId,
      hashToken("ack_cascade_secret"),
    );

    // A second, still-pending (never redeemed) enrollment token under the
    // same grant.
    const pending = await mintGrantEnrollmentToken(
      db,
      { ownerId: "space_1", grantId },
      "http://example.test",
    );

    // A fake live bridge connection registered for the completed machine.
    let closed = false;
    const fakeConnection = {
      signal: new AbortController().signal,
      closed: Promise.resolve(),
      close: () => {
        closed = true;
      },
    } as unknown as import("@agentclientprotocol/sdk").ClientConnection;
    registerMachineBridge(machineId, fakeConnection);

    await revokeRouterEnrollmentGrantCascadeCore(db, grantId);

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

    const [pendingRow] = await db
      .select()
      .from(acprouterEnrollmentTokens)
      .where(eq(acprouterEnrollmentTokens.id, pending.machineId));
    expect(pendingRow?.usedAt).toBeTruthy();

    expect(closed).toBe(true);
    expect(getMachineBridge(machineId)).toBeUndefined();

    unregisterMachineBridge(machineId, fakeConnection);
  });

  it("leaves an unrelated grant's rows completely untouched", async () => {
    const grantA = await seedGrant("grant_cascade_a");
    const grantB = await seedGrant("grant_cascade_b");
    const { keyId: keyIdA } = await createCompletedEnrollment(
      grantA,
      hashToken("ack_cascade_secret_a"),
    );
    const { machineId: machineIdB, keyId: keyIdB } = await createCompletedEnrollment(
      grantB,
      hashToken("ack_cascade_secret_b"),
    );

    await revokeRouterEnrollmentGrantCascadeCore(db, grantA);

    const [keyA] = await db
      .select()
      .from(acprouterConsumerApiKeys)
      .where(eq(acprouterConsumerApiKeys.id, keyIdA));
    expect(keyA?.revokedAt).toBeTruthy();

    const [keyB] = await db
      .select()
      .from(acprouterConsumerApiKeys)
      .where(eq(acprouterConsumerApiKeys.id, keyIdB));
    expect(keyB?.revokedAt).toBeNull();

    const [credentialB] = await db
      .select()
      .from(acprouterMachineBridgeCredentials)
      .where(eq(acprouterMachineBridgeCredentials.machineId, machineIdB));
    expect(credentialB?.revokedAt).toBeNull();
  });

  it("is idempotent — re-running against an already-revoked grant touches zero additional rows", async () => {
    const grantId = await seedGrant("grant_cascade_idempotent");
    const { keyId } = await createCompletedEnrollment(grantId, hashToken("ack_cascade_secret_c"));

    await revokeRouterEnrollmentGrantCascadeCore(db, grantId);
    const [keyAfterFirst] = await db
      .select()
      .from(acprouterConsumerApiKeys)
      .where(eq(acprouterConsumerApiKeys.id, keyId));
    const revokedAtFirst = keyAfterFirst?.revokedAt?.getTime();

    await revokeRouterEnrollmentGrantCascadeCore(db, grantId);
    const [keyAfterSecond] = await db
      .select()
      .from(acprouterConsumerApiKeys)
      .where(eq(acprouterConsumerApiKeys.id, keyId));
    expect(keyAfterSecond?.revokedAt?.getTime()).toBe(revokedAtFirst);
  });
});
