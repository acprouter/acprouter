import { rmSync } from "node:fs";
import path from "node:path";
import * as acp from "@agentclientprotocol/sdk";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import { type Database, getDb } from "../../../db";
import {
  acprouterEnrollmentTokens,
  acprouterMachineBridgeCredentials,
  acprouterMachines,
  acprouterRouterEnrollmentGrants,
} from "../../../db/schema";
import { streamFromWebSocket } from "./acp-ws-stream";
import {
  acceptMachineBridgeConnection,
  MACHINE_BRIDGE_CLOSE_CODE,
  type PresentedBridgeCredential,
} from "./machine-bridge-connection";
import {
  mintEnrollmentToken,
  mintGrantEnrollmentToken,
  redeemEnrollmentToken,
} from "./machines-logic";

const SCRATCH_DIR = ".data/machine-bridge-connection-credential-test";

/**
 * Task 5.1's own verification: the bridge WS route's credential gate. The
 * production machine bridge route resolves a `PresentedBridgeCredential`
 * synchronously from the request (query param vs `Authorization: Bearer`
 * header vs neither) and
 * passes it as `acceptMachineBridgeConnection`'s 5th argument — this test's
 * `wss` connection handler does the identical resolution from the same two
 * places a real `NextRequest` would expose them, over a real `ws` socket,
 * so this is a faithful stand-in for that route rather than calling the
 * credential-check function in isolation.
 */
describe("acceptMachineBridgeConnection — bridge credential gate (Task 5.1)", () => {
  let db: Database;
  let wss: WebSocketServer;
  let port: number;

  beforeAll(async () => {
    rmSync(SCRATCH_DIR, { recursive: true, force: true });
    process.env.PG_DATABASE_URL = `pglite://${SCRATCH_DIR}`;
    db = await getDb({
      migrationsFolder: path.resolve(
        __dirname,
        "../../../../../../apps/acprouter/src/db/migrations",
      ),
    });

    wss = new WebSocketServer({ port: 0 });
    port = (wss.address() as { port: number }).port;
    wss.on("connection", (socket, req) => {
      const url = new URL(req.url ?? "", "http://localhost");
      const machineId = url.searchParams.get("machineId");
      const presentedCredential: PresentedBridgeCredential = (() => {
        if (url.searchParams.has("credential") || url.searchParams.has("bridgeCredential")) {
          return { presentation: "query_param" };
        }
        const authHeader = req.headers.authorization;
        if (authHeader?.startsWith("Bearer ")) {
          const value = authHeader.slice("Bearer ".length).trim();
          if (value) return { presentation: "header", value };
        }
        return { presentation: "none" };
      })();

      acceptMachineBridgeConnection(
        Promise.resolve(db),
        machineId,
        socket,
        undefined,
        presentedCredential,
      );
    });
  });

  afterAll(async () => {
    wss.close();
    rmSync(SCRATCH_DIR, { recursive: true, force: true });
  });

  afterEach(async () => {
    await db.delete(acprouterMachineBridgeCredentials);
    await db.delete(acprouterMachines);
    await db.delete(acprouterEnrollmentTokens);
    await db.delete(acprouterRouterEnrollmentGrants);
  });

  async function seedGrant(id = "reg_bridge_cred_test") {
    await db.insert(acprouterRouterEnrollmentGrants).values({
      id,
      issuer: "https://busabase.test",
      clientId: "busabase-enrollment-client",
      acprouterUserId: "user_1",
      acprouterSpaceId: "space_1",
    });
    return id;
  }

  async function createLegacyMachine(): Promise<string> {
    const minted = await mintEnrollmentToken(db, {}, "http://example.test");
    const redeemed = await redeemEnrollmentToken(db, { token: minted.token, label: "legacy" });
    return redeemed.machineId;
  }

  async function createOauthEnrollmentMachine(): Promise<{
    machineId: string;
    bridgeCredential: string;
  }> {
    const grantId = await seedGrant();
    const minted = await mintGrantEnrollmentToken(
      db,
      { ownerId: "space_1", grantId },
      "http://example.test",
    );
    const redeemed = await redeemEnrollmentToken(db, {
      token: minted.token,
      label: "oauth-device",
    });
    if (!redeemed.bridgeCredential) throw new Error("expected a bridge credential");
    return { machineId: redeemed.machineId, bridgeCredential: redeemed.bridgeCredential };
  }

  function buildFakeMachineAgent(): acp.AgentApp {
    return acp.agent({ name: "fake-cli" }).onRequest(acp.methods.agent.initialize, () => ({
      protocolVersion: acp.PROTOCOL_VERSION,
      agentCapabilities: { loadSession: false },
      authMethods: [],
    }));
  }

  function connectRaw(url: string): Promise<{ socket: WebSocket; closeCode: number }> {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(url);
      socket.once("open", () => {
        const agentApp = buildFakeMachineAgent();
        agentApp.connect(streamFromWebSocket(socket));
      });
      socket.once("close", (code) => resolve({ socket, closeCode: code }));
      socket.once("error", reject);
    });
  }

  it("a LEGACY machine connects successfully with no credential at all — unchanged behavior", async () => {
    const machineId = await createLegacyMachine();
    const url = `ws://127.0.0.1:${port}?machineId=${machineId}`;
    const socket = new WebSocket(url);

    const closeCodeOrOpen = await new Promise<"open" | number>((resolve, reject) => {
      socket.once("open", () => {
        const agentApp = buildFakeMachineAgent();
        agentApp.connect(streamFromWebSocket(socket));
        resolve("open");
      });
      socket.once("close", (code) => resolve(code));
      socket.once("error", reject);
    });

    expect(closeCodeOrOpen).toBe("open");
    socket.close();
  }, 10_000);

  it("an oauth-enrollment machine connects successfully when the correct credential is presented as a header", async () => {
    const { machineId, bridgeCredential } = await createOauthEnrollmentMachine();
    const url = `ws://127.0.0.1:${port}?machineId=${machineId}`;
    const socket = new WebSocket(url, { headers: { authorization: `Bearer ${bridgeCredential}` } });

    const closeCodeOrOpen = await new Promise<"open" | number>((resolve, reject) => {
      socket.once("open", () => {
        const agentApp = buildFakeMachineAgent();
        agentApp.connect(streamFromWebSocket(socket));
        resolve("open");
      });
      socket.once("close", (code) => resolve(code));
      socket.once("error", reject);
    });

    expect(closeCodeOrOpen).toBe("open");
    socket.close();
  }, 10_000);

  it("an oauth-enrollment machine is rejected when no credential is presented at all", async () => {
    const { machineId } = await createOauthEnrollmentMachine();
    const url = `ws://127.0.0.1:${port}?machineId=${machineId}`;
    const { closeCode } = await connectRaw(url);
    expect(closeCode).toBe(MACHINE_BRIDGE_CLOSE_CODE.invalidCredential);
  }, 10_000);

  it("an oauth-enrollment machine is rejected when the credential is presented as a QUERY PARAMETER instead of a header, even if the value is otherwise correct", async () => {
    const { machineId, bridgeCredential } = await createOauthEnrollmentMachine();
    const url = `ws://127.0.0.1:${port}?machineId=${machineId}&credential=${bridgeCredential}`;
    const { closeCode } = await connectRaw(url);
    expect(closeCode).toBe(MACHINE_BRIDGE_CLOSE_CODE.invalidCredential);
  }, 10_000);

  it("an oauth-enrollment machine is rejected when the presented header credential is wrong", async () => {
    const { machineId } = await createOauthEnrollmentMachine();
    const url = `ws://127.0.0.1:${port}?machineId=${machineId}`;
    const socket = new WebSocket(url, {
      headers: { authorization: "Bearer abc_not_the_right_one" },
    });
    const closeCode = await new Promise<number>((resolve, reject) => {
      socket.once("open", () => {
        const agentApp = buildFakeMachineAgent();
        agentApp.connect(streamFromWebSocket(socket));
      });
      socket.once("close", (code) => resolve(code));
      socket.once("error", reject);
    });
    expect(closeCode).toBe(MACHINE_BRIDGE_CLOSE_CODE.invalidCredential);
  }, 10_000);

  it("an oauth-enrollment machine is rejected once its own credential has been revoked, even though it was valid at mint time", async () => {
    const { machineId, bridgeCredential } = await createOauthEnrollmentMachine();
    const { eq } = await import("drizzle-orm");
    await db
      .update(acprouterMachineBridgeCredentials)
      .set({ revokedAt: new Date() })
      .where(eq(acprouterMachineBridgeCredentials.machineId, machineId));

    const url = `ws://127.0.0.1:${port}?machineId=${machineId}`;
    const socket = new WebSocket(url, { headers: { authorization: `Bearer ${bridgeCredential}` } });
    const closeCode = await new Promise<number>((resolve, reject) => {
      socket.once("open", () => {
        const agentApp = buildFakeMachineAgent();
        agentApp.connect(streamFromWebSocket(socket));
      });
      socket.once("close", (code) => resolve(code));
      socket.once("error", reject);
    });
    expect(closeCode).toBe(MACHINE_BRIDGE_CLOSE_CODE.invalidCredential);
  }, 10_000);

  it("an unknown machineId is rejected the same way regardless of any credential presented", async () => {
    const url = `ws://127.0.0.1:${port}?machineId=does_not_exist`;
    const { closeCode } = await connectRaw(url);
    expect(closeCode).toBe(MACHINE_BRIDGE_CLOSE_CODE.unknownMachine);
  }, 10_000);
});
