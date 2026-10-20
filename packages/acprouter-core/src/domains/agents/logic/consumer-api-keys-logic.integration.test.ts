import { rmSync } from "node:fs";
import path from "node:path";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { runWithMemberContext } from "../../../context";
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
import {
  listConsumerApiKeys,
  mintConsumerApiKey,
  registerConsumerKeyHash,
  revokeConsumerApiKey,
} from "./consumer-api-keys-logic";

const SCRATCH_DIR = ".data/consumer-api-keys-logic-test";

/**
 * Real PGLite, real cross-tenant regression coverage for the security gap
 * flagged directly against this file: `listConsumerApiKeys`/
 * `mintConsumerApiKey`/`revokeConsumerApiKey` used to take a bare
 * `agentId`/key `id` with zero ownership check, so tenant B could list,
 * mint, or revoke tenant A's consumer API keys just by knowing (or
 * guessing) tenant A's `agentId`/key id. Same cross-tenant regression shape
 * as `machines-logic.integration.test.ts`'s own ownerId test — mint/create
 * under `runWithMemberContext({ ownerId: "tenant-a" })`, then attempt the
 * operation under `"tenant-b"` and assert it is rejected, plus assert the
 * same-tenant case still works (no false-positive lockout).
 */
describe("consumer-api-keys-logic tenant scoping", () => {
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

  let agentCounter = 0;
  /** Inserts a real agent row directly under a given owner — the same
   *  shape `session-events-logic.integration.test.ts`'s own `createAgent`
   *  helper uses, just parameterized by owner instead of hard-coding
   *  `"local"`. */
  async function createAgent(ownerId: string): Promise<string> {
    agentCounter += 1;
    const id = `agt_test_${agentCounter}`;
    await db.insert(acprouterAgents).values({
      id,
      ownerId,
      machineId: null,
      kind: "remote-acp",
      label: "Test Agent",
      status: "connected",
    });
    return id;
  }

  describe("listConsumerApiKeys", () => {
    it("the owning tenant can list its agent's keys", async () => {
      const agentId = await createAgent("tenant-a");
      await runWithMemberContext({ db, ownerId: "tenant-a" }, () =>
        mintConsumerApiKey(db, agentId, "prod", "http://example.test"),
      );

      const keys = await runWithMemberContext({ db, ownerId: "tenant-a" }, () =>
        listConsumerApiKeys(db, agentId),
      );
      expect(keys).toHaveLength(1);
    });

    it("a different tenant cannot list another tenant's agent's keys — rejects NOT_FOUND instead of leaking the list", async () => {
      const agentId = await createAgent("tenant-a");
      await runWithMemberContext({ db, ownerId: "tenant-a" }, () =>
        mintConsumerApiKey(db, agentId, "prod", "http://example.test"),
      );

      await expect(
        runWithMemberContext({ db, ownerId: "tenant-b" }, () => listConsumerApiKeys(db, agentId)),
      ).rejects.toMatchObject({ code: "NOT_FOUND" });
    });
  });

  describe("mintConsumerApiKey", () => {
    it("the owning tenant can mint a key for its own agent", async () => {
      const agentId = await createAgent("tenant-a");
      const result = await runWithMemberContext({ db, ownerId: "tenant-a" }, () =>
        mintConsumerApiKey(db, agentId, "prod", "http://example.test"),
      );
      expect(result.key.agentId).toBe(agentId);
      expect(result.rawKey).toMatch(/^ack_[0-9a-f]{48}$/);
    });

    it("a different tenant cannot mint a key against another tenant's agentId — rejects NOT_FOUND and persists nothing", async () => {
      const agentId = await createAgent("tenant-a");

      await expect(
        runWithMemberContext({ db, ownerId: "tenant-b" }, () =>
          mintConsumerApiKey(db, agentId, "stolen", "http://example.test"),
        ),
      ).rejects.toMatchObject({ code: "NOT_FOUND" });

      const rows = await db
        .select()
        .from(acprouterConsumerApiKeys)
        .where(eq(acprouterConsumerApiKeys.agentId, agentId));
      expect(rows).toHaveLength(0);
    });

    it("the owning tenant cannot mint a key for its own agent once it has been soft-removed", async () => {
      const agentId = await createAgent("tenant-a");
      await db
        .update(acprouterAgents)
        .set({ deletedAt: new Date() })
        .where(eq(acprouterAgents.id, agentId));

      await expect(
        runWithMemberContext({ db, ownerId: "tenant-a" }, () =>
          mintConsumerApiKey(db, agentId, "prod", "http://example.test"),
        ),
      ).rejects.toMatchObject({ code: "NOT_FOUND" });

      const rows = await db
        .select()
        .from(acprouterConsumerApiKeys)
        .where(eq(acprouterConsumerApiKeys.agentId, agentId));
      expect(rows).toHaveLength(0);
    });
  });

  describe("revokeConsumerApiKey", () => {
    it("the owning tenant can revoke its own key", async () => {
      const agentId = await createAgent("tenant-a");
      const minted = await runWithMemberContext({ db, ownerId: "tenant-a" }, () =>
        mintConsumerApiKey(db, agentId, "prod", "http://example.test"),
      );

      const result = await runWithMemberContext({ db, ownerId: "tenant-a" }, () =>
        revokeConsumerApiKey(db, minted.key.id),
      );
      expect(result.ok).toBe(true);

      const [row] = await db
        .select()
        .from(acprouterConsumerApiKeys)
        .where(eq(acprouterConsumerApiKeys.id, minted.key.id));
      expect(row.revokedAt).not.toBeNull();
    });

    it("a different tenant cannot revoke another tenant's key by id — rejects NOT_FOUND and the key stays live", async () => {
      const agentId = await createAgent("tenant-a");
      const minted = await runWithMemberContext({ db, ownerId: "tenant-a" }, () =>
        mintConsumerApiKey(db, agentId, "prod", "http://example.test"),
      );

      await expect(
        runWithMemberContext({ db, ownerId: "tenant-b" }, () =>
          revokeConsumerApiKey(db, minted.key.id),
        ),
      ).rejects.toMatchObject({ code: "NOT_FOUND" });

      const [row] = await db
        .select()
        .from(acprouterConsumerApiKeys)
        .where(eq(acprouterConsumerApiKeys.id, minted.key.id));
      expect(row.revokedAt).toBeNull();
    });

    it("revoking an unknown key id rejects NOT_FOUND regardless of the caller's tenant", async () => {
      await expect(
        runWithMemberContext({ db, ownerId: "tenant-a" }, () =>
          revokeConsumerApiKey(db, "cak_does_not_exist"),
        ),
      ).rejects.toMatchObject({ code: "NOT_FOUND" });
    });
  });

  /**
   * `registerConsumerKeyHash` real-DB coverage (Codex interim review
   * blockers 3/4) — isolated from the Cloud route tests that already
   * exercise its happy path, specifically targeting: (1) the agent-readiness
   * check now requires `status === "connected"`, not mere row existence;
   * (2) a mismatched `intendedAgentSlug` is rejected even though an agent
   * row for the machine exists and is connected; (3) two concurrent calls
   * for the same `(grantId, enrollmentId)` with the SAME hash both resolve
   * to the identical `already_registered` outcome (one `registered`, one
   * recovered from the unique-violation race) rather than one of them
   * throwing an unhandled 500.
   */
  describe("registerConsumerKeyHash", () => {
    let grantCounter = 0;

    /** Minimal real grant row — this package has no concept of Router
     *  membership/space (that lives in Cloud's `grant-membership-check.ts`),
     *  so the grant row itself is inserted directly rather than through a
     *  Cloud-only helper, exactly as `grant-revocation-cascade-core.test.ts`
     *  already does for the same reason. */
    async function createGrant(): Promise<string> {
      grantCounter += 1;
      const id = `regr_test_${grantCounter}`;
      await db.insert(acprouterRouterEnrollmentGrants).values({
        id,
        issuer: "https://acprouter.test",
        clientId: "busabase-cloud-enrollment",
        acprouterUserId: "user_test",
        acprouterSpaceId: "space_test",
        createdAt: new Date(),
      });
      return id;
    }

    /** Mints + redeems a real grant-scoped enrollment token, giving back a
     *  real `enrollmentId` (`=== machineId`) backed by actual
     *  `acprouterMachines`/`acprouterEnrollmentTokens` rows — the exact
     *  precondition `registerConsumerKeyHash` requires before it will even
     *  consider an agent row. */
    async function redeemDevice(
      grantId: string,
      intendedAgentSlug?: string,
    ): Promise<{ enrollmentId: string }> {
      const { mintGrantEnrollmentToken, redeemEnrollmentToken } = await import("./machines-logic");
      const minted = await mintGrantEnrollmentToken(
        db,
        { ownerId: "space_test", grantId, intendedAgentSlug },
        "https://acprouter.test",
      );
      const redeemed = await redeemEnrollmentToken(db, { token: minted.token });
      return { enrollmentId: redeemed.machineId };
    }

    it("rejects agent_not_ready when an agent row exists but is not connected (status is the real readiness signal, not row existence)", async () => {
      const grantId = await createGrant();
      const { enrollmentId } = await redeemDevice(grantId);
      await upsertBridgedAgent(db, {
        ownerId: "space_test",
        machineId: enrollmentId,
        registrySlug: "claude-acp",
        label: "Claude",
        cwd: "/home/user/project",
        detectedVersion: "1.0.0",
        status: "auth_required",
      });

      const result = await registerConsumerKeyHash(
        db,
        grantId,
        enrollmentId,
        "a".repeat(64),
        "https://acprouter.test",
      );
      expect(result).toEqual({ outcome: "rejected", reason: "agent_not_ready" });

      const completions = await db.select().from(acprouterEnrollmentCompletions);
      expect(completions).toHaveLength(0);
    });

    it("rejects agent_not_ready when the connected agent's registrySlug does not match the mint call's intendedAgentSlug", async () => {
      const grantId = await createGrant();
      const { enrollmentId } = await redeemDevice(grantId, "codex-acp");
      // The machine actually bridged Claude, not the Codex Busabase intended.
      await upsertBridgedAgent(db, {
        ownerId: "space_test",
        machineId: enrollmentId,
        registrySlug: "claude-acp",
        label: "Claude",
        cwd: "/home/user/project",
        detectedVersion: "1.0.0",
        status: "connected",
      });

      const result = await registerConsumerKeyHash(
        db,
        grantId,
        enrollmentId,
        "a".repeat(64),
        "https://acprouter.test",
      );
      expect(result).toEqual({ outcome: "rejected", reason: "agent_not_ready" });

      const completions = await db.select().from(acprouterEnrollmentCompletions);
      expect(completions).toHaveLength(0);
    });

    it("registers successfully when the connected agent's registrySlug matches intendedAgentSlug", async () => {
      const grantId = await createGrant();
      const { enrollmentId } = await redeemDevice(grantId, "claude-acp");
      await upsertBridgedAgent(db, {
        ownerId: "space_test",
        machineId: enrollmentId,
        registrySlug: "claude-acp",
        label: "Claude",
        cwd: "/home/user/project",
        detectedVersion: "1.0.0",
        status: "connected",
      });

      const result = await registerConsumerKeyHash(
        db,
        grantId,
        enrollmentId,
        "a".repeat(64),
        "https://acprouter.test",
      );
      expect(result.outcome).toBe("registered");
    });

    it("two concurrent registrations with the SAME hash for the SAME (grantId, enrollmentId) both resolve to a consistent outcome, with exactly one consumer key persisted (Codex interim review blocker 3)", async () => {
      const grantId = await createGrant();
      const { enrollmentId } = await redeemDevice(grantId);
      await upsertBridgedAgent(db, {
        ownerId: "space_test",
        machineId: enrollmentId,
        registrySlug: "claude-acp",
        label: "Claude",
        cwd: "/home/user/project",
        detectedVersion: "1.0.0",
        status: "connected",
      });

      const hash = "b".repeat(64);
      const [first, second] = await Promise.all([
        registerConsumerKeyHash(db, grantId, enrollmentId, hash, "https://acprouter.test"),
        registerConsumerKeyHash(db, grantId, enrollmentId, hash, "https://acprouter.test"),
      ]);

      // Neither call may be a thrown error / rejected outcome — the race
      // loser must recover into a correct verdict, not surface the raw
      // unique-violation.
      expect(["registered", "already_registered"]).toContain(first.outcome);
      expect(["registered", "already_registered"]).toContain(second.outcome);
      // Both resolve to the SAME agentId/key — they describe the one
      // winning row, not two independent registrations.
      if (first.outcome !== "rejected" && second.outcome !== "rejected") {
        expect(first.key.id).toBe(second.key.id);
        expect(first.agentId).toBe(second.agentId);
      }

      const keys = await db
        .select()
        .from(acprouterConsumerApiKeys)
        .where(eq(acprouterConsumerApiKeys.keyHash, hash));
      expect(keys).toHaveLength(1);
      const completions = await db
        .select()
        .from(acprouterEnrollmentCompletions)
        .where(eq(acprouterEnrollmentCompletions.enrollmentId, enrollmentId));
      expect(completions).toHaveLength(1);
    });

    it("a concurrent registration with a DIFFERENT hash for the SAME (grantId, enrollmentId) is rejected as hash_mismatch, never silently accepted", async () => {
      const grantId = await createGrant();
      const { enrollmentId } = await redeemDevice(grantId);
      await upsertBridgedAgent(db, {
        ownerId: "space_test",
        machineId: enrollmentId,
        registrySlug: "claude-acp",
        label: "Claude",
        cwd: "/home/user/project",
        detectedVersion: "1.0.0",
        status: "connected",
      });

      const [first, second] = await Promise.all([
        registerConsumerKeyHash(
          db,
          grantId,
          enrollmentId,
          "c".repeat(64),
          "https://acprouter.test",
        ),
        registerConsumerKeyHash(
          db,
          grantId,
          enrollmentId,
          "d".repeat(64),
          "https://acprouter.test",
        ),
      ]);
      const outcomes = [first.outcome, second.outcome].sort();
      // Exactly one wins (registered), the other is rejected as a mismatch —
      // never both "registered", never both silently accepted.
      expect(outcomes).toEqual(["registered", "rejected"]);

      const keys = await db.select().from(acprouterConsumerApiKeys);
      expect(keys).toHaveLength(1);
    });

    /**
     * Orchestrator review blocker 2: `revokeConsumerApiKey` (a standalone
     * key revoke, independent of the grant-revocation cascade or the
     * abandoned-completion cleanup) must tombstone the completion row bound
     * to that key too — otherwise the completion's own `revokedAt IS NULL`
     * unique index entry stays live, which would permanently block a
     * genuinely NEW pairing for the same `(grantId, enrollmentId)` since the
     * old completion row never frees the unique slot. The fresh pairing
     * below deliberately uses a DIFFERENT hash — a real Busabase retry mints
     * a brand-new secret, never resubmits the one tied to a key it was just
     * told is revoked, and `acprouter_consumer_api_keys_hash_idx` is a
     * global unconditional unique index (correctly — a revoked hash must
     * never be reusable as a live credential), so reusing the old hash here
     * would collide on THAT index, not the one this test is targeting.
     */
    it("revoking the consumer key tombstones its completion and requires a new enrollment", async () => {
      const grantId = await createGrant();
      const { enrollmentId } = await redeemDevice(grantId);
      await upsertBridgedAgent(db, {
        ownerId: "space_test",
        machineId: enrollmentId,
        registrySlug: "claude-acp",
        label: "Claude",
        cwd: "/home/user/project",
        detectedVersion: "1.0.0",
        status: "connected",
      });

      const original = await registerConsumerKeyHash(
        db,
        grantId,
        enrollmentId,
        "e".repeat(64),
        "https://acprouter.test",
      );
      if (original.outcome === "rejected") throw new Error("expected registration to succeed");

      await runWithMemberContext({ db, ownerId: "space_test" }, () =>
        revokeConsumerApiKey(db, original.key.id),
      );

      const [completion] = await db
        .select()
        .from(acprouterEnrollmentCompletions)
        .where(eq(acprouterEnrollmentCompletions.enrollmentId, enrollmentId));
      expect(completion?.revokedAt).toBeTruthy();

      // A new hash cannot resurrect this tombstoned enrollment. The user
      // must mint and redeem a new enrollment instead.
      const retried = await registerConsumerKeyHash(
        db,
        grantId,
        enrollmentId,
        "f".repeat(64),
        "https://acprouter.test",
      );
      expect(retried).toEqual({ outcome: "rejected", reason: "agent_not_ready" });
    });

    /**
     * Orchestrator review blocker 2's narrower claim: even if a completion
     * row's own `revokedAt` somehow lags behind its key's (the defensive
     * case `resolveExistingCompletion`'s key-revoked check guards, separate
     * from `revokeConsumerApiKey`'s now-added cascade that keeps them in
     * sync in the normal path) — a retry presenting that key's exact hash
     * must never resolve as `already_registered` for a revoked key. Forces
     * that lagging state directly rather than through the normal revoke
     * call, to isolate this specific guard from the cascade that now also
     * prevents it in the normal path.
     *
     * This lagging state is a genuinely inconsistent one no normal code path
     * can produce anymore (every revoke call site keeps both rows'
     * `revokedAt` in sync) — so the only real contract this test can hold
     * `registerConsumerKeyHash` to is "never silently resolves
     * already_registered for the dead key." What it does instead (reject
     * outright on the now-unresolvable state, since the hash is both
     * globally reserved by the dead key AND the live completion row can't be
     * matched) is an acceptable, non-silent failure for state the
     * application itself can no longer create.
     */
    it("never resolves already_registered for a revoked key, even if its completion row's own revokedAt lags behind (defensive, independent of the revoke cascade)", async () => {
      const grantId = await createGrant();
      const { enrollmentId } = await redeemDevice(grantId);
      await upsertBridgedAgent(db, {
        ownerId: "space_test",
        machineId: enrollmentId,
        registrySlug: "claude-acp",
        label: "Claude",
        cwd: "/home/user/project",
        detectedVersion: "1.0.0",
        status: "connected",
      });

      const original = await registerConsumerKeyHash(
        db,
        grantId,
        enrollmentId,
        "g".repeat(64),
        "https://acprouter.test",
      );
      if (original.outcome === "rejected") throw new Error("expected registration to succeed");

      // Simulate the lagging-state directly: revoke the KEY only, leaving
      // the completion row's own `revokedAt` untouched (unlike the real
      // `revokeConsumerApiKey`, which now keeps both in sync).
      await db
        .update(acprouterConsumerApiKeys)
        .set({ revokedAt: new Date() })
        .where(eq(acprouterConsumerApiKeys.id, original.key.id));

      // Never resolves as `already_registered` for the dead key — either a
      // clean `rejected`/`registered` outcome, or a loud failure, but never
      // a silent reactivation.
      await expect(
        registerConsumerKeyHash(
          db,
          grantId,
          enrollmentId,
          "g".repeat(64),
          "https://acprouter.test",
        ),
      ).resolves.toEqual({ outcome: "rejected", reason: "agent_not_ready" });
    });
  });
});
