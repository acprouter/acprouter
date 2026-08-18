import { rmSync } from "node:fs";
import path from "node:path";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { runWithMemberContext } from "../../../context";
import { type Database, getDb } from "../../../db";
import { acprouterAgents, acprouterConsumerApiKeys } from "../../../db/schema";
import {
  listConsumerApiKeys,
  mintConsumerApiKey,
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
    await db.delete(acprouterConsumerApiKeys);
    await db.delete(acprouterAgents);
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
});
