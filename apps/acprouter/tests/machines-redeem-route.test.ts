import { rmSync } from "node:fs";
import { mintEnrollmentToken } from "@acprouter/core";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { POST } from "~/app/api/v1/machines/redeem/route";
import { getDb } from "~/db";
import { acprouterEnrollmentTokens, acprouterMachines } from "~/db/schema";

const SCRATCH_DIR = ".data/machines-redeem-route-test";

function postRedeem(body: unknown): Promise<Response> {
  return POST(
    new Request("http://localhost:15420/api/v1/machines/redeem", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

describe("POST /api/v1/machines/redeem", () => {
  beforeAll(async () => {
    rmSync(SCRATCH_DIR, { recursive: true, force: true });
    process.env.PG_DATABASE_URL = `pglite://${SCRATCH_DIR}`;
    await getDb();
  });

  afterAll(() => {
    rmSync(SCRATCH_DIR, { recursive: true, force: true });
  });

  beforeEach(async () => {
    const db = await getDb();
    await db.delete(acprouterMachines);
    await db.delete(acprouterEnrollmentTokens);
  });

  it("redeems a valid token and returns 200 with the machineId", async () => {
    const db = await getDb();
    const minted = await mintEnrollmentToken(db, {}, "http://localhost:15420");

    const response = await postRedeem({ token: minted.token, label: "test-machine" });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({ machineId: minted.machineId, intendedAgentSlug: null });
  });

  it("returns the mint dialog's intendedAgentSlug so the CLI can detect the right tool", async () => {
    const db = await getDb();
    const minted = await mintEnrollmentToken(
      db,
      { intendedAgentSlug: "claude-acp" },
      "http://localhost:15420",
    );

    const response = await postRedeem({ token: minted.token });
    const body = await response.json();
    expect(body).toEqual({ machineId: minted.machineId, intendedAgentSlug: "claude-acp" });
  });

  it("refuses a malformed body with 400, not a crash", async () => {
    const response = await postRedeem({ notAToken: true });
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toBe("invalid_token");
  });

  it("refuses reusing the same token with a specific 400 error, per the acceptance criterion", async () => {
    const db = await getDb();
    const minted = await mintEnrollmentToken(db, {}, "http://localhost:15420");

    const first = await postRedeem({ token: minted.token });
    expect(first.status).toBe(200);

    const second = await postRedeem({ token: minted.token });
    expect(second.status).toBe(400);
    const body = await second.json();
    expect(body).toMatchObject({ error: "already_used" });
    expect(typeof body.message).toBe("string");
    expect(body.message.length).toBeGreaterThan(0);
  });

  it("refuses an unrecognized token with a specific reason, not a generic failure", async () => {
    const response = await postRedeem({ token: "acp_does_not_exist" });
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body).toMatchObject({ error: "invalid_token" });
  });
});
