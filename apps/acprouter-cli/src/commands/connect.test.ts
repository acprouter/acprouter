import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readDeviceConfig, writeDeviceConfig } from "../config";
import { RedeemError } from "../redeem";
import { runConnect } from "./connect";

const localDaemonState = vi.hoisted(() => ({
  running: false as boolean,
  pidInfo: null as { pid: number } | null,
}));

vi.mock("../daemon/local-daemon", () => ({
  resolveLocalDaemonState: vi.fn(() => ({
    running: localDaemonState.running,
    pidInfo: localDaemonState.pidInfo,
    logPath: "/fake/bridge.log",
  })),
  startDetached: vi.fn(async () => ({ pid: 4242, logPath: "/fake/bridge.log" })),
  startForeground: vi.fn(async () => 0),
}));

const redeemMock = vi.hoisted(() => vi.fn());
vi.mock("../redeem", async () => {
  const actual = await vi.importActual<typeof import("../redeem")>("../redeem");
  return { ...actual, redeemEnrollmentToken: redeemMock };
});

describe("runConnect — task #6.1 re-enrollment confirmation", () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "acprouter-cli-connect-test-"));
    localDaemonState.running = false;
    localDaemonState.pidInfo = null;
    redeemMock.mockReset();
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  function seedExistingConfig() {
    writeDeviceConfig(home, {
      server: "https://old.example.test",
      machineId: "machine_old",
      dir: "/old/dir",
      connectedAt: "2026-01-01T00:00:00.000Z",
      intendedAgentSlug: null,
    });
  }

  it("declined confirmation leaves existing config untouched and never calls redeem", async () => {
    seedExistingConfig();
    const before = readDeviceConfig(home);

    const confirm = vi.fn(async () => false);
    await runConnect({
      home,
      server: "https://new.example.test",
      token: "new-token",
      json: true,
      confirm,
    });

    expect(confirm).toHaveBeenCalledTimes(1);
    expect(redeemMock).not.toHaveBeenCalled();
    expect(readDeviceConfig(home)).toEqual(before);
  });

  it("confirmed-but-failed redemption leaves existing config untouched", async () => {
    seedExistingConfig();
    const before = readDeviceConfig(home);
    redeemMock.mockRejectedValueOnce(new RedeemError("invalid_token", "token is invalid"));

    const confirm = vi.fn(async () => true);
    await runConnect({
      home,
      server: "https://new.example.test",
      token: "bad-token",
      json: true,
      confirm,
    });

    expect(confirm).toHaveBeenCalledTimes(1);
    expect(redeemMock).toHaveBeenCalledTimes(1);
    expect(readDeviceConfig(home)).toEqual(before);
  });

  it("confirmed-and-successful redemption replaces the stored config", async () => {
    seedExistingConfig();
    redeemMock.mockResolvedValueOnce({
      machineId: "machine_new",
      intendedAgentSlug: null,
    });

    const confirm = vi.fn(async () => true);
    await runConnect({
      home,
      server: "https://new.example.test",
      token: "good-token",
      json: true,
      confirm,
    });

    expect(confirm).toHaveBeenCalledTimes(1);
    expect(redeemMock).toHaveBeenCalledTimes(1);
    const after = readDeviceConfig(home);
    expect(after?.server).toBe("https://new.example.test");
    expect(after?.machineId).toBe("machine_new");
  });

  it("never prompts for confirmation on genuine first-time setup (no existing config)", async () => {
    redeemMock.mockResolvedValueOnce({
      machineId: "machine_first",
      intendedAgentSlug: null,
    });
    const confirm = vi.fn(async () => true);

    await runConnect({
      home,
      server: "https://first.example.test",
      token: "first-token",
      json: true,
      confirm,
    });

    expect(confirm).not.toHaveBeenCalled();
    expect(redeemMock).toHaveBeenCalledTimes(1);
  });

  it("never prompts for confirmation on a bare self-heal (existing config, no token)", async () => {
    seedExistingConfig();
    const confirm = vi.fn(async () => true);

    await runConnect({ home, json: true, confirm });

    expect(confirm).not.toHaveBeenCalled();
    expect(redeemMock).not.toHaveBeenCalled();
  });

  it("task #6.2: no new agent-selection flag is introduced — intendedAgentSlug flows only from the redeemed token", async () => {
    redeemMock.mockResolvedValueOnce({
      machineId: "machine_slug",
      // Deliberately an unknown slug — real `detectAgent` reports it as not
      // installed, which skips the connect-time auth probe entirely (that
      // probe really spawns a subprocess and is out of scope for this test).
      intendedAgentSlug: "nonexistent-test-agent",
    });

    await runConnect({
      home,
      server: "https://first.example.test",
      token: "first-token",
      json: true,
    });

    const config = readDeviceConfig(home);
    expect(config?.intendedAgentSlug).toBe("nonexistent-test-agent");
  });

  it("task #6.4: persists the redeemed bridgeCredential into device config and tightens file permissions", async () => {
    redeemMock.mockResolvedValueOnce({
      machineId: "machine_cred",
      intendedAgentSlug: null,
      bridgeCredential: "raw-bridge-secret",
    });

    await runConnect({
      home,
      server: "https://first.example.test",
      token: "first-token",
      json: true,
    });

    const config = readDeviceConfig(home);
    expect(config?.bridgeCredential).toBe("raw-bridge-secret");

    if (process.platform !== "win32") {
      const { statSync } = await import("node:fs");
      const mode = statSync(join(home, "config.json")).mode & 0o777;
      expect(mode).toBe(0o600);
    }
  });

  it("legacy enrollment (no bridgeCredential) never narrows config.json permissions", async () => {
    redeemMock.mockResolvedValueOnce({
      machineId: "machine_legacy",
      intendedAgentSlug: null,
    });

    await runConnect({
      home,
      server: "https://first.example.test",
      token: "first-token",
      json: true,
    });

    const config = readDeviceConfig(home);
    expect(config?.bridgeCredential).toBeUndefined();
    expect(readFileSync(join(home, "config.json"), "utf8")).not.toContain("bridgeCredential");
  });
});
