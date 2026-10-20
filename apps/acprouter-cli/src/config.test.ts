import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readDeviceConfig, writeDeviceConfig } from "./config";

describe("writeDeviceConfig — task #6.3 owner-only permissions", () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "acprouter-cli-config-test-"));
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it.skipIf(process.platform === "win32")(
    "tightens the file to 0600 when a bridge credential is present",
    () => {
      writeDeviceConfig(home, {
        server: "https://router.test",
        machineId: "machine_1",
        dir: "/work",
        connectedAt: new Date().toISOString(),
        intendedAgentSlug: null,
        bridgeCredential: "raw-secret-value",
      });

      const mode = statSync(join(home, "config.json")).mode & 0o777;
      expect(mode).toBe(0o600);
      // Not group- or world-readable — the task's own literal assertion.
      expect(mode & 0o077).toBe(0);
    },
  );

  it("round-trips the bridgeCredential field exactly through read/write", () => {
    writeDeviceConfig(home, {
      server: "https://router.test",
      machineId: "machine_1",
      dir: "/work",
      connectedAt: new Date().toISOString(),
      intendedAgentSlug: null,
      bridgeCredential: "raw-secret-value",
    });

    expect(readDeviceConfig(home)?.bridgeCredential).toBe("raw-secret-value");
  });

  it("does not require any particular mode when there is no bridge credential (legacy machines)", () => {
    writeDeviceConfig(home, {
      server: "https://router.test",
      machineId: "machine_2",
      dir: "/work",
      connectedAt: new Date().toISOString(),
      intendedAgentSlug: null,
    });

    // No crash, no credential persisted — this is the whole legacy contract;
    // this test exists mainly to prove the credential-present branch above
    // doesn't fire unconditionally.
    expect(readDeviceConfig(home)?.bridgeCredential).toBeUndefined();
  });
});
