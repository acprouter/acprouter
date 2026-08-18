import { rmSync } from "node:fs";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  getContextDb,
  LOCAL_OWNER_ID,
  resolveOwnerId,
  runWithLocalContext,
  runWithMemberContext,
} from "./context";
import { type Database, getDb } from "./db";
import * as schema from "./db/schema";
import { acprouterAgents } from "./db/schema";
import { listAgents } from "./domains/agents/logic/agents-logic";

const SCRATCH_DIR = ".data/context-seam-test";
const MIGRATIONS_FOLDER = path.resolve(__dirname, "../../../apps/acprouter/src/db/migrations");

/**
 * Real proof of the seam added in this task, not just "the old path still
 * works" (that's covered by every OTHER integration test in this package
 * continuing to pass unchanged — none of them ever call `runWithMemberContext`,
 * so `resolveOwnerId()`/`getContextDb()` fall through to their absent-value
 * defaults exactly as `LOCAL_OWNER_ID`/the direct `db` parameter did before).
 *
 * This file proves the NEW path: a `runWithMemberContext({ db, ownerId }, …)`
 * call actually redirects `getDb()` to the injected db instance (not the OSS
 * singleton) and scopes a real `domains/agents/logic/` query
 * (`listAgents`) to the injected owner id (not `LOCAL_OWNER_ID`) — using two
 * genuinely separate real PGLite databases, not two schemas in one.
 */
describe("context seam (runWithLocalContext / runWithMemberContext)", () => {
  let localDb: Database;
  let tenantDb: Database;

  beforeAll(async () => {
    rmSync(SCRATCH_DIR, { recursive: true, force: true });
    process.env.PG_DATABASE_URL = `pglite://${SCRATCH_DIR}`;
    // The OSS singleton — resolved through the normal `getDb()` path, exactly
    // like every other integration test in this package.
    localDb = await getDb({ migrationsFolder: MIGRATIONS_FOLDER });

    // A SECOND, wholly independent database — never touches
    // `packages/acprouter-core`'s `globalThis` singleton at all, standing in
    // for a hosted host's own drizzle client (already carrying its other
    // tables) that `runWithMemberContext` injects.
    const tenantClient = await new PGlite("memory://");
    tenantDb = drizzle({ client: tenantClient, schema });
    await migrate(tenantDb, { migrationsFolder: MIGRATIONS_FOLDER });
  });

  afterAll(() => {
    rmSync(SCRATCH_DIR, { recursive: true, force: true });
  });

  beforeEach(async () => {
    await localDb.delete(acprouterAgents);
    await tenantDb.delete(acprouterAgents);
  });

  it("outside any context, resolveOwnerId/getContextDb fall through to the OSS local defaults", () => {
    expect(resolveOwnerId()).toBe(LOCAL_OWNER_ID);
    expect(getContextDb()).toBeUndefined();
  });

  it("runWithLocalContext sets nothing — same absent-value defaults as no context at all", async () => {
    await runWithLocalContext(async () => {
      expect(resolveOwnerId()).toBe(LOCAL_OWNER_ID);
      expect(getContextDb()).toBeUndefined();
      // getDb() must still resolve the OSS singleton, unaffected.
      const resolved = await getDb();
      expect(resolved).toBe(localDb);
    });
  });

  it("runWithMemberContext redirects getDb()/getContextDb() to the injected db, not the OSS singleton", async () => {
    await runWithMemberContext({ db: tenantDb, ownerId: "tenant-a" }, async () => {
      expect(getContextDb()).toBe(tenantDb);
      expect(resolveOwnerId()).toBe("tenant-a");
      const resolved = await getDb();
      expect(resolved).toBe(tenantDb);
      expect(resolved).not.toBe(localDb);
    });

    // Leaving the callback un-scopes it — no leakage into surrounding code.
    expect(resolveOwnerId()).toBe(LOCAL_OWNER_ID);
    expect(getContextDb()).toBeUndefined();
  });

  it("listAgents scopes to the injected tenant db + owner, ignoring same-table rows under a different owner in that SAME injected db", async () => {
    await tenantDb.insert(acprouterAgents).values({
      id: "agt_tenant_a",
      ownerId: "tenant-a",
      machineId: null,
      kind: "remote-acp",
      registrySlug: null,
      label: "Tenant A's agent",
      status: "connected",
    });
    await tenantDb.insert(acprouterAgents).values({
      id: "agt_tenant_b",
      ownerId: "tenant-b",
      machineId: null,
      kind: "remote-acp",
      registrySlug: null,
      label: "Tenant B's agent",
      status: "connected",
    });

    const asTenantA = await runWithMemberContext({ db: tenantDb, ownerId: "tenant-a" }, () =>
      listAgents(tenantDb),
    );
    expect(asTenantA.map((a) => a.id)).toEqual(["agt_tenant_a"]);

    const asTenantB = await runWithMemberContext({ db: tenantDb, ownerId: "tenant-b" }, () =>
      listAgents(tenantDb),
    );
    expect(asTenantB.map((a) => a.id)).toEqual(["agt_tenant_b"]);
  });

  it("listAgents against the OSS singleton is unaffected by rows that exist only in the injected tenant db", async () => {
    await localDb.insert(acprouterAgents).values({
      id: "agt_local_only",
      ownerId: LOCAL_OWNER_ID,
      machineId: null,
      kind: "remote-acp",
      registrySlug: null,
      label: "Local agent",
      status: "connected",
    });
    await tenantDb.insert(acprouterAgents).values({
      id: "agt_tenant_only",
      ownerId: "tenant-a",
      machineId: null,
      kind: "remote-acp",
      registrySlug: null,
      label: "Tenant agent",
      status: "connected",
    });

    // No context active — the exact call shape every existing OSS route uses.
    const localAgents = await listAgents(localDb);
    expect(localAgents.map((a) => a.id)).toEqual(["agt_local_only"]);
  });
});
