import type { ChildProcessByStdio } from "node:child_process";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { configFilePath, pidFilePath } from "../config";

/**
 * Exercises the real CLI as a subprocess against a scratch home directory —
 * not a unit test of the internal functions, because the whole point of
 * this task (spec §5.4b) is process lifecycle behavior that only shows up
 * when something is actually spawned, detached, and killed.
 *
 * Spawned explicitly via the `tsx` binary rather than
 * `[process.execPath, ...process.execArgv]`: that trick is correct in
 * `local-daemon.ts` (the CLI re-invoking *itself* always has a consistent
 * loader), but here the parent process is vitest's own worker, whose
 * `execArgv` carries vite-node's module system, not a loader a freshly
 * spawned `node cli.ts` can reuse to parse TypeScript.
 */
const CLI_ENTRY = fileURLToPath(new URL("../cli.ts", import.meta.url));
const TSX_BIN = fileURLToPath(
  new URL("../../../../node_modules/tsx/dist/cli.mjs", import.meta.url),
);

function runCli(args: string[], home: string) {
  return spawnSync(process.execPath, [TSX_BIN, CLI_ENTRY, ...args, "--home", home, "--json"], {
    encoding: "utf8",
    timeout: 10_000,
  });
}

function readJson(stdout: string): unknown {
  return JSON.parse(stdout);
}

const FAKE_ROUTER_SCRIPT = fileURLToPath(
  new URL("./__fixtures__/fake-router-server.mjs", import.meta.url),
);

/**
 * A minimal fake Router — just enough of `POST /api/v1/machines/redeem` to
 * exercise the CLI's real HTTP call (task #5), without needing the full
 * Next.js app. Always succeeds, since these tests are about daemon
 * lifecycle (detach/self-heal/stale_pid), not the redeem endpoint's own
 * business rules — those are covered in `machines-logic.integration.test.ts`
 * and `apps/acprouter/tests/machines-redeem-route.test.ts`.
 *
 * Spawned as its own OS process (`__fixtures__/fake-router-server.mjs`),
 * not hosted inline via `http.createServer` in this test file — a server
 * living in the test runner's own process is unreachable from the CLI
 * subprocess this test spawns (a grandchild relative to the runner);
 * sibling processes can reach each other over loopback, a grandchild
 * cannot reach a server in its grandparent. This is a hard-won finding,
 * not a stylistic choice — the inline version hangs every CLI `fetch()`
 * call until `spawnSync`'s own timeout kills it, with zero output.
 */
function startFakeRouter(): Promise<{ url: string; close: () => void }> {
  return new Promise((resolve, reject) => {
    const proc: ChildProcessByStdio<null, Readable, Readable> = spawn(
      process.execPath,
      [FAKE_ROUTER_SCRIPT],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    const timer = setTimeout(() => {
      proc.kill();
      reject(new Error("Fake router did not report ready in time"));
    }, 5000);

    proc.stdout.on("data", (chunk: Buffer) => {
      const match = chunk.toString().match(/SERVER_READY (\d+)/);
      if (match) {
        clearTimeout(timer);
        resolve({
          url: `http://127.0.0.1:${match[1]}`,
          close: () => proc.kill(),
        });
      }
    });
    proc.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

describe("acprouter-cli daemon lifecycle", () => {
  let home: string;
  let fakeRouter: { url: string; close: () => void };

  beforeAll(async () => {
    fakeRouter = await startFakeRouter();
  });

  afterAll(() => {
    fakeRouter.close();
  });

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "acprouter-cli-test-"));
  });

  afterEach(() => {
    // Best-effort: stop whatever might still be running before deleting the dir.
    runCli(["stop", "--force"], home);
    rmSync(home, { recursive: true, force: true });
  });

  it("connect without a config and without --server/--token fails, not hangs", () => {
    const result = runCli(["connect"], home);
    expect(result.status).toBe(1);
  });

  it("connect starts a detached bridge that survives the CLI process exiting", () => {
    const connect = runCli(["connect", "--server", fakeRouter.url, "--token", "tok_test"], home);
    expect(connect.status).toBe(0);
    const connected = readJson(connect.stdout) as { pid: number };
    expect(connected.pid).toBeGreaterThan(0);
    expect(existsSync(pidFilePath(home))).toBe(true);
    expect(existsSync(configFilePath(home))).toBe(true);

    const status = runCli(["status"], home);
    const statusResult = readJson(status.stdout) as { status: string; pid: number };
    expect(statusResult.status).toBe("running");
    expect(statusResult.pid).toBe(connected.pid);
  });

  it("connect is idempotent — a second run reports already_running, not a new PID", () => {
    const first = runCli(["connect", "--server", fakeRouter.url, "--token", "tok_test"], home);
    const firstPid = (readJson(first.stdout) as { pid: number }).pid;

    const second = runCli(["connect"], home);
    const secondResult = readJson(second.stdout) as { action: string; pid: number };
    expect(secondResult.action).toBe("already_running");
    expect(secondResult.pid).toBe(firstPid);
  });

  it("stop cleans up the PID file, and status afterwards reads stopped", () => {
    runCli(["connect", "--server", fakeRouter.url, "--token", "tok_test"], home);
    const stop = runCli(["stop"], home);
    expect(stop.status).toBe(0);
    expect(existsSync(pidFilePath(home))).toBe(false);

    const status = runCli(["status"], home);
    expect((readJson(status.stdout) as { status: string }).status).toBe("stopped");
  });

  it("an externally-killed process is reported as stale_pid, not stopped", () => {
    const connect = runCli(["connect", "--server", fakeRouter.url, "--token", "tok_test"], home);
    const pid = (readJson(connect.stdout) as { pid: number }).pid;

    process.kill(pid, "SIGKILL");
    // Give the OS a moment to actually reap/mark the process gone.
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline) {
      try {
        process.kill(pid, 0);
      } catch {
        break;
      }
    }

    const status = runCli(["status"], home);
    expect((readJson(status.stdout) as { status: string }).status).toBe("stale_pid");
  });

  it("connect self-heals from stale_pid without requiring --server/--token again", () => {
    const connect = runCli(["connect", "--server", fakeRouter.url, "--token", "tok_test"], home);
    const firstPid = (readJson(connect.stdout) as { pid: number }).pid;
    process.kill(firstPid, "SIGKILL");
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline) {
      try {
        process.kill(firstPid, 0);
      } catch {
        break;
      }
    }

    const healed = runCli(["connect"], home);
    expect(healed.status).toBe(0);
    const healedResult = readJson(healed.stdout) as { action: string; pid: number; server: string };
    expect(healedResult.action).toBe("self_healed");
    expect(healedResult.pid).not.toBe(firstPid);
    expect(healedResult.server).toBe(fakeRouter.url);
  });

  it("restart replaces the running process with a new PID", () => {
    const connect = runCli(["connect", "--server", fakeRouter.url, "--token", "tok_test"], home);
    const firstPid = (readJson(connect.stdout) as { pid: number }).pid;

    const restart = runCli(["restart"], home);
    expect(restart.status).toBe(0);
    const restarted = readJson(restart.stdout) as { pid: number };
    expect(restarted.pid).not.toBe(firstPid);
    expect(existsSync(pidFilePath(home))).toBe(true);
  });
});
