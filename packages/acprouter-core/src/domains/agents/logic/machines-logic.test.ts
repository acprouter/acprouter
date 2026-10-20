import { rmSync } from "node:fs";
import path from "node:path";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { type Database, getDb } from "../../../db";
import {
  acprouterEnrollmentTokens,
  acprouterMachineBridgeCredentials,
  acprouterMachines,
  acprouterRouterEnrollmentGrants,
} from "../../../db/schema";
import {
  getGrantEnrollmentStatus,
  hashToken,
  markMachineOnline,
  mintGrantEnrollmentToken,
  redeemEnrollmentToken,
} from "./machines-logic";

const SCRATCH_DIR = ".data/machines-logic-grant-test";

describe("machines-logic — grant-scoped (oauth-enrollment) transactional path", () => {
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
    await db.delete(acprouterMachineBridgeCredentials);
    await db.delete(acprouterMachines);
    await db.delete(acprouterEnrollmentTokens);
    await db.delete(acprouterRouterEnrollmentGrants);
  });

  async function seedGrant(id = "reg_test1") {
    await db.insert(acprouterRouterEnrollmentGrants).values({
      id,
      issuer: "https://busabase.test",
      clientId: "busabase-enrollment-client",
      acprouterUserId: "user_1",
      acprouterSpaceId: "space_1",
    });
    return id;
  }

  it("redeeming a grant-scoped token atomically creates the claimed token, the machine (enrolledVia=oauth-enrollment, grantId set), and a bridge credential row — and returns the raw credential exactly once", async () => {
    const grantId = await seedGrant();
    const minted = await mintGrantEnrollmentToken(
      db,
      { ownerId: "tenant-a", grantId },
      "http://example.test",
    );

    const redeemed = await redeemEnrollmentToken(db, { token: minted.token, label: "laptop" });

    expect(redeemed.machineId).toBe(minted.machineId);
    expect(redeemed.bridgeCredential).toMatch(/^abc_[0-9a-f]{48}$/);

    const [tokenRow] = await db
      .select()
      .from(acprouterEnrollmentTokens)
      .where(eq(acprouterEnrollmentTokens.id, minted.machineId));
    expect(tokenRow.usedAt).not.toBeNull();

    const [machineRow] = await db
      .select()
      .from(acprouterMachines)
      .where(eq(acprouterMachines.id, minted.machineId));
    expect(machineRow).toMatchObject({
      enrolledVia: "oauth-enrollment",
      grantId,
      ownerId: "tenant-a",
      label: "laptop",
    });

    const credentialRows = await db
      .select()
      .from(acprouterMachineBridgeCredentials)
      .where(eq(acprouterMachineBridgeCredentials.machineId, minted.machineId));
    expect(credentialRows).toHaveLength(1);
    expect(credentialRows[0].credentialHash).toBe(hashToken(redeemed.bridgeCredential as string));
  });

  it("rolls back the ENTIRE transaction — including the token claim — when the credential insert fails, leaving the token re-redeemable and no machine/credential rows behind", async () => {
    const grantId = await seedGrant();
    const minted = await mintGrantEnrollmentToken(
      db,
      { ownerId: "tenant-a", grantId },
      "http://example.test",
    );

    // Pre-insert a bridge-credential row with the SAME id the transactional
    // redeem path will deterministically generate is not possible (its id is
    // random) — instead, force the failure the same way the real primitive
    // would hit one: pre-insert a MACHINE row with the token's id, so the
    // transaction's own `acprouterMachines` insert collides on the primary
    // key and the whole transaction (claim included) rolls back.
    await db.insert(acprouterMachines).values({
      id: minted.machineId,
      ownerId: "someone-else",
      label: "colliding-machine",
      tunnelId: minted.machineId,
      status: "offline",
    });

    await expect(redeemEnrollmentToken(db, { token: minted.token })).rejects.toThrow();

    // The token must NOT have been burned by the rolled-back transaction.
    const [tokenRow] = await db
      .select()
      .from(acprouterEnrollmentTokens)
      .where(eq(acprouterEnrollmentTokens.id, minted.machineId));
    expect(tokenRow.usedAt).toBeNull();

    // No bridge credential leaked out of the rolled-back transaction.
    const credentialRows = await db
      .select()
      .from(acprouterMachineBridgeCredentials)
      .where(eq(acprouterMachineBridgeCredentials.machineId, minted.machineId));
    expect(credentialRows).toHaveLength(0);

    // Clean up the pre-seeded colliding machine row and confirm the token
    // really is still redeemable now that the collision is gone.
    await db.delete(acprouterMachines).where(eq(acprouterMachines.id, minted.machineId));
    const retried = await redeemEnrollmentToken(db, { token: minted.token });
    expect(retried.machineId).toBe(minted.machineId);
    expect(retried.bridgeCredential).not.toBeNull();
  });

  it("rolls back the ENTIRE transaction — including the machine insert and the token claim — when the LATER credential insert specifically fails (not the machine insert)", async () => {
    // The previous test's failure happens AT the machine-insert step (a PK
    // collision on that very statement) — Task 4.2's literal requirement is
    // narrower and stronger: a failure injected AFTER the machine insert has
    // already run, but BEFORE the credential insert succeeds, must still
    // roll back everything, including the already-executed machine insert.
    // Forced here with a real Postgres trigger that raises on INSERT into
    // `acprouter_machine_bridge_credentials` — this fires strictly after the
    // preceding machine-insert statement in the same transaction has already
    // executed, giving a genuine "failed between machine-insert and
    // credential-insert" fault, not a same-statement collision.
    const grantId = await seedGrant();
    const minted = await mintGrantEnrollmentToken(
      db,
      { ownerId: "tenant-a", grantId },
      "http://example.test",
    );

    await db.execute(`
      create or replace function _test_reject_bridge_credential_insert()
      returns trigger as $$
      begin
        raise exception 'injected failure: credential insert blocked by test trigger';
      end;
      $$ language plpgsql;
    `);
    await db.execute(`
      create trigger _test_reject_bridge_credential_insert
      before insert on acprouter_machine_bridge_credentials
      for each row execute function _test_reject_bridge_credential_insert();
    `);

    try {
      await expect(redeemEnrollmentToken(db, { token: minted.token })).rejects.toThrow();
    } finally {
      await db.execute(`
        drop trigger _test_reject_bridge_credential_insert on acprouter_machine_bridge_credentials;
      `);
      await db.execute(`
        drop function _test_reject_bridge_credential_insert();
      `);
    }

    // The machine insert DID run (it precedes the credential insert in
    // program order) — rollback must have undone it too, not just skipped
    // the credential insert that failed.
    const machines = await db
      .select()
      .from(acprouterMachines)
      .where(eq(acprouterMachines.id, minted.machineId));
    expect(machines).toHaveLength(0);

    // The token must NOT have been burned either.
    const [tokenRow] = await db
      .select()
      .from(acprouterEnrollmentTokens)
      .where(eq(acprouterEnrollmentTokens.id, minted.machineId));
    expect(tokenRow.usedAt).toBeNull();

    // Confirm the token is genuinely still redeemable now that the trigger
    // is gone — the exact behavior Task 4.2 requires of this rollback.
    const retried = await redeemEnrollmentToken(db, { token: minted.token });
    expect(retried.machineId).toBe(minted.machineId);
    expect(retried.bridgeCredential).not.toBeNull();
    const [machineRow] = await db
      .select()
      .from(acprouterMachines)
      .where(eq(acprouterMachines.id, minted.machineId));
    expect(machineRow).toBeDefined();
  });

  it("rejects an expired grant-scoped token within the same atomic guard, and does not burn it or create partial rows", async () => {
    const grantId = await seedGrant();
    const minted = await mintGrantEnrollmentToken(
      db,
      { ownerId: "tenant-a", grantId },
      "http://example.test",
    );
    await db
      .update(acprouterEnrollmentTokens)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(acprouterEnrollmentTokens.id, minted.machineId));

    await expect(redeemEnrollmentToken(db, { token: minted.token })).rejects.toMatchObject({
      code: "expired",
    });

    const [tokenRow] = await db
      .select()
      .from(acprouterEnrollmentTokens)
      .where(eq(acprouterEnrollmentTokens.id, minted.machineId));
    expect(tokenRow.usedAt).toBeNull();

    const machines = await db
      .select()
      .from(acprouterMachines)
      .where(eq(acprouterMachines.id, minted.machineId));
    expect(machines).toHaveLength(0);
  });

  it("regression (Task 4.3): legacy redemption keeps its original response without a bridge credential field", async () => {
    const { mintEnrollmentToken } = await import("./machines-logic");
    const minted = await mintEnrollmentToken(db, {}, "http://example.test");

    const redeemed = await redeemEnrollmentToken(db, {
      token: minted.token,
      label: "legacy-machine",
    });

    expect(redeemed.machineId).toBe(minted.machineId);
    expect(redeemed).not.toHaveProperty("bridgeCredential");

    const [machineRow] = await db
      .select()
      .from(acprouterMachines)
      .where(eq(acprouterMachines.id, minted.machineId));
    expect(machineRow.enrolledVia).toBe("legacy");
    expect(machineRow.grantId).toBeNull();

    const credentialRows = await db
      .select()
      .from(acprouterMachineBridgeCredentials)
      .where(eq(acprouterMachineBridgeCredentials.machineId, minted.machineId));
    expect(credentialRows).toHaveLength(0);
  });

  it("Task 4.5: a redemption that bridges in time is reported 'online', not 'failed', even after its deadline has since passed", async () => {
    const grantId = await seedGrant();
    const minted = await mintGrantEnrollmentToken(
      db,
      { ownerId: "tenant-a", grantId },
      "http://example.test",
    );
    const redeemed = await redeemEnrollmentToken(db, { token: minted.token });

    await markMachineOnline(db, redeemed.machineId);

    // Backdate the deadline to simulate time having since passed — a
    // machine that already bridged must stay 'online', never flip to
    // 'failed' just because its ORIGINAL deadline window has elapsed.
    await db
      .update(acprouterMachines)
      .set({ bridgeDeadlineAt: new Date(Date.now() - 1000) })
      .where(eq(acprouterMachines.id, redeemed.machineId));

    const status = await getGrantEnrollmentStatus(db, grantId, minted.enrollmentId);
    expect(status).toEqual({ state: "online", machineId: redeemed.machineId });
  });

  it("Task 4.5: a redemption that does NOT bridge before its deadline is reported 'failed', independent of the token's own (already-consumed) TTL state", async () => {
    const grantId = await seedGrant();
    const minted = await mintGrantEnrollmentToken(
      db,
      { ownerId: "tenant-a", grantId },
      "http://example.test",
    );
    const redeemed = await redeemEnrollmentToken(db, { token: minted.token });

    // Never call markMachineOnline — simulate the CLI redeeming but never
    // actually completing a bridge handshake, then backdate the deadline.
    await db
      .update(acprouterMachines)
      .set({ bridgeDeadlineAt: new Date(Date.now() - 1000) })
      .where(eq(acprouterMachines.id, redeemed.machineId));

    const status = await getGrantEnrollmentStatus(db, grantId, minted.enrollmentId);
    expect(status).toEqual({ state: "failed", machineId: redeemed.machineId });
  });

  it("Task 4.4: getGrantEnrollmentStatus reports not_redeemed/redeemed_offline/online across the full lifecycle, scoped by (grantId, enrollmentId)", async () => {
    const grantId = await seedGrant();
    const otherGrantId = await seedGrant("reg_other");

    const minted = await mintGrantEnrollmentToken(
      db,
      { ownerId: "tenant-a", grantId },
      "http://example.test",
    );

    expect(await getGrantEnrollmentStatus(db, grantId, minted.enrollmentId)).toEqual({
      state: "not_redeemed",
    });

    const redeemed = await redeemEnrollmentToken(db, { token: minted.token });

    expect(await getGrantEnrollmentStatus(db, grantId, minted.enrollmentId)).toEqual({
      state: "redeemed_offline",
      machineId: redeemed.machineId,
    });
    // A different grant must never see this grant's enrollment status, even
    // though both grants exist in the same test database, EVEN if (by
    // coincidence of this test reusing the same enrollmentId value) it
    // presents the exact same enrollmentId string.
    expect(await getGrantEnrollmentStatus(db, otherGrantId, minted.enrollmentId)).toEqual({
      state: "not_redeemed",
    });

    await markMachineOnline(db, redeemed.machineId);
    expect(await getGrantEnrollmentStatus(db, grantId, minted.enrollmentId)).toEqual({
      state: "online",
      machineId: redeemed.machineId,
    });
  });

  it("Task 4.4 correction: two devices enrolled under the SAME grant are isolated — each enrollmentId reports only its own machine's state", async () => {
    const grantId = await seedGrant();

    const mintedA = await mintGrantEnrollmentToken(
      db,
      { ownerId: "tenant-a", grantId },
      "http://example.test",
    );
    const mintedB = await mintGrantEnrollmentToken(
      db,
      { ownerId: "tenant-a", grantId },
      "http://example.test",
    );
    expect(mintedA.enrollmentId).not.toBe(mintedB.enrollmentId);

    // Device A redeems and bridges; device B never redeems at all.
    const redeemedA = await redeemEnrollmentToken(db, { token: mintedA.token });
    await markMachineOnline(db, redeemedA.machineId);

    expect(await getGrantEnrollmentStatus(db, grantId, mintedA.enrollmentId)).toEqual({
      state: "online",
      machineId: redeemedA.machineId,
    });
    // Device B's OWN enrollmentId must report ITS OWN not_redeemed state —
    // never device A's online machine, despite sharing the same grantId.
    expect(await getGrantEnrollmentStatus(db, grantId, mintedB.enrollmentId)).toEqual({
      state: "not_redeemed",
    });

    // Now redeem device B too, and confirm each enrollmentId still only
    // ever reports its own machine, never the sibling's.
    const redeemedB = await redeemEnrollmentToken(db, { token: mintedB.token });
    expect(await getGrantEnrollmentStatus(db, grantId, mintedB.enrollmentId)).toEqual({
      state: "redeemed_offline",
      machineId: redeemedB.machineId,
    });
    expect(await getGrantEnrollmentStatus(db, grantId, mintedA.enrollmentId)).toEqual({
      state: "online",
      machineId: redeemedA.machineId,
    });
  });

  it("Task 4.2 correction: redeeming a grant-scoped token rejects when the live grant check reports the grant is no longer valid, and burns nothing", async () => {
    const grantId = await seedGrant();
    const minted = await mintGrantEnrollmentToken(
      db,
      { ownerId: "tenant-a", grantId },
      "http://example.test",
    );

    const revokedGrantCheck = async () => false;
    await expect(
      redeemEnrollmentToken(db, { token: minted.token }, revokedGrantCheck),
    ).rejects.toMatchObject({ code: "grant_invalid" });

    // Nothing was claimed/created — the token remains genuinely redeemable
    // once the grant is (hypothetically) live again.
    const [tokenRow] = await db
      .select()
      .from(acprouterEnrollmentTokens)
      .where(eq(acprouterEnrollmentTokens.id, minted.machineId));
    expect(tokenRow.usedAt).toBeNull();

    const machines = await db
      .select()
      .from(acprouterMachines)
      .where(eq(acprouterMachines.id, minted.machineId));
    expect(machines).toHaveLength(0);

    const liveGrantCheck = async () => true;
    const redeemed = await redeemEnrollmentToken(db, { token: minted.token }, liveGrantCheck);
    expect(redeemed.machineId).toBe(minted.machineId);
  });

  it("Task 4.2 correction: a LEGACY (grantId === null) redeem never invokes the live-grant-check callback at all", async () => {
    const { mintEnrollmentToken } = await import("./machines-logic");
    const minted = await mintEnrollmentToken(db, {}, "http://example.test");

    let called = false;
    const spyCheck = async () => {
      called = true;
      return false;
    };

    const redeemed = await redeemEnrollmentToken(db, { token: minted.token }, spyCheck);
    expect(redeemed.machineId).toBe(minted.machineId);
    expect(called).toBe(false);
  });
});
