import { rmSync } from "node:fs";
import path from "node:path";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { type Database, getDb } from "../../../db";
import {
  acprouterAgents,
  acprouterEnrollmentTokens,
  acprouterMachines,
  acprouterUsageRecords,
} from "../../../db/schema";
import { listAgents, markAgentsDisconnected, upsertBridgedAgent } from "./agents-logic";
import { mintEnrollmentToken, redeemEnrollmentToken } from "./machines-logic";

const SCRATCH_DIR = ".data/agents-logic-test";
const OWNER_ID = "local";

describe("agents-logic", () => {
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
    await db.delete(acprouterUsageRecords);
    await db.delete(acprouterAgents);
    await db.delete(acprouterMachines);
    await db.delete(acprouterEnrollmentTokens);
  });

  async function createMachine(label = "test-machine"): Promise<string> {
    const minted = await mintEnrollmentToken(db, {}, "http://example.test");
    const redeemed = await redeemEnrollmentToken(db, { token: minted.token, label });
    return redeemed.machineId;
  }

  it("upsertBridgedAgent inserts a new row for a fresh (machineId, registrySlug) pair", async () => {
    const machineId = await createMachine();

    await upsertBridgedAgent(db, {
      ownerId: OWNER_ID,
      machineId,
      registrySlug: "claude-acp",
      label: "Claude Code",
      cwd: "/home/user/projects/foo",
      detectedVersion: "1.2.3",
      status: "connected",
    });

    const agents = await listAgents(db);
    expect(agents).toHaveLength(1);
    expect(agents[0]).toMatchObject({
      kind: "bridged",
      registrySlug: "claude-acp",
      label: "Claude Code",
      machineId,
      cwd: "/home/user/projects/foo",
      detectedVersion: "1.2.3",
      status: "connected",
      statusDetail: null,
    });
  });

  it("upsertBridgedAgent updates the SAME row on a second call for the same (machineId, registrySlug) pair, not a duplicate", async () => {
    const machineId = await createMachine();

    await upsertBridgedAgent(db, {
      ownerId: OWNER_ID,
      machineId,
      registrySlug: "claude-acp",
      label: "Claude Code",
      cwd: "/old/dir",
      detectedVersion: "1.0.0",
      status: "connected",
    });
    const [firstRow] = await listAgents(db);

    await upsertBridgedAgent(db, {
      ownerId: OWNER_ID,
      machineId,
      registrySlug: "claude-acp",
      label: "Claude Code",
      cwd: "/new/dir",
      detectedVersion: "1.1.0",
      status: "connected",
    });

    const agents = await listAgents(db);
    expect(agents).toHaveLength(1);
    expect(agents[0].id).toBe(firstRow.id);
    expect(agents[0].cwd).toBe("/new/dir");
    expect(agents[0].detectedVersion).toBe("1.1.0");
  });

  it("upsertBridgedAgent keeps distinct rows for two different machines bridging the same registrySlug", async () => {
    const machineA = await createMachine("laptop-a");
    const machineB = await createMachine("laptop-b");

    await upsertBridgedAgent(db, {
      ownerId: OWNER_ID,
      machineId: machineA,
      registrySlug: "claude-acp",
      label: "Claude Code",
      cwd: "/a",
      detectedVersion: null,
      status: "connected",
    });
    await upsertBridgedAgent(db, {
      ownerId: OWNER_ID,
      machineId: machineB,
      registrySlug: "claude-acp",
      label: "Claude Code",
      cwd: "/b",
      detectedVersion: null,
      status: "connected",
    });

    const agents = await listAgents(db);
    expect(agents).toHaveLength(2);
    expect(new Set(agents.map((a) => a.machineId))).toEqual(new Set([machineA, machineB]));
  });

  it("markAgentsDisconnected flips every agent row for a machine to disconnected, and does not touch other machines' rows", async () => {
    const machineA = await createMachine("laptop-a");
    const machineB = await createMachine("laptop-b");

    await upsertBridgedAgent(db, {
      ownerId: OWNER_ID,
      machineId: machineA,
      registrySlug: "claude-acp",
      label: "Claude Code",
      cwd: "/a",
      detectedVersion: "1.0.0",
      status: "connected",
    });
    await upsertBridgedAgent(db, {
      ownerId: OWNER_ID,
      machineId: machineB,
      registrySlug: "codex-acp",
      label: "Codex",
      cwd: "/b",
      detectedVersion: "2.0.0",
      status: "connected",
    });

    await markAgentsDisconnected(db, machineA);

    const agents = await listAgents(db);
    const agentA = agents.find((a) => a.machineId === machineA);
    const agentB = agents.find((a) => a.machineId === machineB);
    expect(agentA?.status).toBe("disconnected");
    expect(agentB?.status).toBe("connected");
  });

  it("markAgentsDisconnected on a machine with no agent rows is a no-op, not an error", async () => {
    const machineId = await createMachine();
    await expect(markAgentsDisconnected(db, machineId)).resolves.toBeUndefined();
    expect(await listAgents(db)).toHaveLength(0);
  });

  it("stores and round-trips the auth_required status with its statusDetail (acceptance criterion 10's exact-next-step string)", async () => {
    const machineId = await createMachine();

    await upsertBridgedAgent(db, {
      ownerId: OWNER_ID,
      machineId,
      registrySlug: "claude-acp",
      label: "Claude Code",
      cwd: "/home/user/projects/foo",
      detectedVersion: "1.2.3",
      status: "auth_required",
      statusDetail: "Sign-in needed: run `claude` in a terminal and finish the browser login.",
    });

    const [agent] = await listAgents(db);
    expect(agent.status).toBe("auth_required");
    expect(agent.statusDetail).toBe(
      "Sign-in needed: run `claude` in a terminal and finish the browser login.",
    );
  });

  it("stores and round-trips the error status with its statusDetail, distinct from auth_required", async () => {
    const machineId = await createMachine();

    await upsertBridgedAgent(db, {
      ownerId: OWNER_ID,
      machineId,
      registrySlug: "claude-acp",
      label: "Claude Code",
      cwd: "/home/user/projects/foo",
      detectedVersion: "1.2.3",
      status: "error",
      statusDetail: "Could not check sign-in status: probe timed out.",
    });

    const [agent] = await listAgents(db);
    expect(agent.status).toBe("error");
    expect(agent.statusDetail).toBe("Could not check sign-in status: probe timed out.");
  });

  it("listAgents only returns rows for the given owner (LOCAL_OWNER_ID scoping, same pattern as listMachines)", async () => {
    const machineId = await createMachine();
    await upsertBridgedAgent(db, {
      ownerId: OWNER_ID,
      machineId,
      registrySlug: "claude-acp",
      label: "Claude Code",
      cwd: "/home/user",
      detectedVersion: null,
      status: "connected",
    });
    // A row under a different owner (can't happen yet in the OSS single-owner
    // edition, but the query itself must not silently ignore the filter).
    await db.insert(acprouterAgents).values({
      id: "agt_other_owner",
      ownerId: "someone-else",
      machineId: null,
      kind: "remote-acp",
      registrySlug: null,
      label: "Someone else's agent",
      status: "connected",
    });

    const agents = await listAgents(db);
    expect(agents.map((a) => a.id)).not.toContain("agt_other_owner");
  });

  it("upsertBridgedAgent's unique (machineId, registrySlug) index is what makes the upsert-not-duplicate behavior safe — asserted directly against the row count in the table, not just listAgents' output", async () => {
    const machineId = await createMachine();
    await upsertBridgedAgent(db, {
      ownerId: OWNER_ID,
      machineId,
      registrySlug: "claude-acp",
      label: "Claude Code",
      cwd: "/x",
      detectedVersion: null,
      status: "connected",
    });
    await upsertBridgedAgent(db, {
      ownerId: OWNER_ID,
      machineId,
      registrySlug: "claude-acp",
      label: "Claude Code",
      cwd: "/y",
      detectedVersion: null,
      status: "disconnected",
    });

    const rows = await db
      .select()
      .from(acprouterAgents)
      .where(eq(acprouterAgents.machineId, machineId));
    expect(rows).toHaveLength(1);
  });
});
