import { rmSync } from "node:fs";
import path from "node:path";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { runWithMemberContext } from "../../../context";
import { type Database, getDb } from "../../../db";
import {
  acprouterAgents,
  acprouterEnrollmentTokens,
  acprouterMachines,
  acprouterUsageRecords,
} from "../../../db/schema";
import {
  listMachines,
  mintEnrollmentToken,
  RedeemEnrollmentTokenError,
  redeemEnrollmentToken,
} from "./machines-logic";

const SCRATCH_DIR = ".data/machines-logic-test";

describe("machines-logic", () => {
  let db: Database;

  beforeAll(async () => {
    rmSync(SCRATCH_DIR, { recursive: true, force: true });
    process.env.PG_DATABASE_URL = `pglite://${SCRATCH_DIR}`;
    // Migrations are generated per-app (spec §7.1), not in this package —
    // point at `apps/acprouter`'s copy explicitly rather than relying on
    // `getDb()`'s `process.cwd()`-relative default.
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
    await db.delete(acprouterUsageRecords);
    await db.delete(acprouterAgents);
    await db.delete(acprouterMachines);
    await db.delete(acprouterEnrollmentTokens);
  });

  it("mints a token with a command embedding the server origin and the token", async () => {
    const result = await mintEnrollmentToken(db, {}, "http://example.test");
    expect(result.token).toMatch(/^acp_[0-9a-f]{48}$/);
    expect(result.command).toBe(
      `npx @acprouter/cli connect --server http://example.test --token ${result.token}`,
    );
    expect(result.machineId).toMatch(/^ent_/);
  });

  it("stores the mint dialog's intendedAgentSlug on the token row, not just discarding it", async () => {
    const minted = await mintEnrollmentToken(
      db,
      { intendedAgentSlug: "claude-acp" },
      "http://example.test",
    );
    const [row] = await db
      .select()
      .from(acprouterEnrollmentTokens)
      .where(eq(acprouterEnrollmentTokens.id, minted.machineId));
    expect(row.intendedAgentSlug).toBe("claude-acp");
  });

  it("redeeming a fresh token creates an online machine reusing the token's id", async () => {
    const minted = await mintEnrollmentToken(db, {}, "http://example.test");
    const redeemed = await redeemEnrollmentToken(db, {
      token: minted.token,
      label: "my-laptop",
      platform: "linux",
      cliVersion: "0.0.1",
    });
    expect(redeemed.machineId).toBe(minted.machineId);

    const machines = await listMachines(db);
    expect(machines).toHaveLength(1);
    expect(machines[0]).toMatchObject({
      id: minted.machineId,
      label: "my-laptop",
      platform: "linux",
      cliVersion: "0.0.1",
      status: "online",
    });
  });

  it("a redeemed machine keeps the MINTING tenant's ownerId, even with a different (or absent) ambient context at redeem time", async () => {
    // Mint happens with a real member context (the dashboard's own call
    // shape) — the token's row carries "tenant-a" as its ownerId.
    const minted = await runWithMemberContext({ db, ownerId: "tenant-a" }, () =>
      mintEnrollmentToken(db, {}, "http://example.test"),
    );

    // Redeem happens with NO ambient context — the CLI's bare HTTP POST has
    // no session/actor of its own, exactly like the real route handler.
    // Before the fix, this read resolveOwnerId()'s absent-context fallback
    // (LOCAL_OWNER_ID) instead of the token's own stored owner, silently
    // misattributing the machine on any multi-tenant host.
    const redeemed = await redeemEnrollmentToken(db, { token: minted.token });

    const [machine] = await db
      .select()
      .from(acprouterMachines)
      .where(eq(acprouterMachines.id, redeemed.machineId));
    expect(machine.ownerId).toBe("tenant-a");

    // And a DIFFERENT tenant's listMachines() must not see it.
    const asTenantB = await runWithMemberContext({ db, ownerId: "tenant-b" }, () =>
      listMachines(db),
    );
    expect(asTenantB).toHaveLength(0);

    const asTenantA = await runWithMemberContext({ db, ownerId: "tenant-a" }, () =>
      listMachines(db),
    );
    expect(asTenantA).toHaveLength(1);
  });

  it("redeeming the same token twice fails the second time — the acceptance criterion", async () => {
    const minted = await mintEnrollmentToken(db, {}, "http://example.test");
    await redeemEnrollmentToken(db, { token: minted.token });

    await expect(redeemEnrollmentToken(db, { token: minted.token })).rejects.toMatchObject({
      code: "already_used",
    });

    // And it must not have created a second machine row.
    expect(await listMachines(db)).toHaveLength(1);
  });

  it("redeeming an unrecognized token fails with invalid_token", async () => {
    await expect(redeemEnrollmentToken(db, { token: "acp_not_real" })).rejects.toMatchObject({
      code: "invalid_token",
    });
  });

  it("redeeming an expired token fails with expired, and does not burn it", async () => {
    const minted = await mintEnrollmentToken(db, {}, "http://example.test");
    // Backdate expiresAt directly — the only way to exercise this path
    // without waiting out the real TTL.
    await db
      .update(acprouterEnrollmentTokens)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(acprouterEnrollmentTokens.id, minted.machineId));

    await expect(redeemEnrollmentToken(db, { token: minted.token })).rejects.toMatchObject({
      code: "expired",
    });
    expect(await listMachines(db)).toHaveLength(0);
  });

  it("mintEnrollmentToken and redeemEnrollmentToken throw RedeemEnrollmentTokenError instances, not plain errors", async () => {
    try {
      await redeemEnrollmentToken(db, { token: "acp_nope" });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(RedeemEnrollmentTokenError);
    }
  });
});
