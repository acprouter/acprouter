import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { rotateLogIfNeeded, spawnDetachedOrThrow } from "./local-daemon";

/** A fake `ChildProcess` good enough for `spawnDetachedOrThrow`'s own contract (it only ever calls `.once`/`.off`, never touches stdio/pid until after a successful spawn). */
class FakeChild extends EventEmitter {
  pid = 4242;
  off(event: string, listener: (...args: unknown[]) => void) {
    return super.off(event, listener);
  }
}

describe("rotateLogIfNeeded", () => {
  let dir: string;
  let logPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "acprouter-cli-log-rotate-"));
    logPath = join(dir, "bridge.log");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("does nothing when there is no log file yet", () => {
    expect(rotateLogIfNeeded(logPath, 10, 2)).toBe(false);
  });

  it("does nothing while the file is under the size threshold", () => {
    writeFileSync(logPath, "short\n");
    expect(rotateLogIfNeeded(logPath, 1024, 2)).toBe(false);
    expect(existsSync(`${logPath}.1`)).toBe(false);
  });

  it("rotates the current log to .1 once the size threshold is crossed", () => {
    writeFileSync(logPath, "x".repeat(20));
    expect(rotateLogIfNeeded(logPath, 10, 2)).toBe(true);
    expect(existsSync(logPath)).toBe(false);
    expect(readFileSync(`${logPath}.1`, "utf8")).toBe("x".repeat(20));
  });

  it("shifts existing backups up and drops the oldest past backupCount", () => {
    writeFileSync(`${logPath}.1`, "generation-1");
    writeFileSync(`${logPath}.2`, "generation-2 (should be dropped)");
    writeFileSync(logPath, "x".repeat(20));

    expect(rotateLogIfNeeded(logPath, 10, 2)).toBe(true);

    expect(existsSync(logPath)).toBe(false);
    expect(readFileSync(`${logPath}.1`, "utf8")).toBe("x".repeat(20));
    expect(readFileSync(`${logPath}.2`, "utf8")).toBe("generation-1");
    // generation-2 was the oldest allowed by backupCount=2 and must be gone,
    // not silently kept around forever — the entire point of this function.
  });

  it("a fresh append after rotation starts a new, empty-then-growing file", () => {
    writeFileSync(logPath, "x".repeat(20));
    rotateLogIfNeeded(logPath, 10, 2);
    expect(existsSync(logPath)).toBe(false);
    writeFileSync(logPath, "new content\n");
    expect(readFileSync(logPath, "utf8")).toBe("new content\n");
  });
});

describe("spawnDetachedOrThrow", () => {
  it("on Windows, retries with windowsHide:false after an EINVAL on the first attempt", async () => {
    const calls: Array<{ windowsHide: unknown }> = [];
    const spawnFn = ((_command: string, _args: string[], options: { windowsHide: unknown }) => {
      calls.push({ windowsHide: options.windowsHide });
      const child = new FakeChild();
      if (calls.length === 1) {
        // Simulate the real Node/Windows EINVAL: the OS-level spawn() call
        // itself fails, emitted as an 'error' event with no 'spawn' at all.
        queueMicrotask(() =>
          child.emit("error", Object.assign(new Error("EINVAL"), { code: "EINVAL" })),
        );
      } else {
        queueMicrotask(() => child.emit("spawn"));
      }
      return child;
    }) as any;

    const child = await spawnDetachedOrThrow(["fake-arg"], {}, { platform: "win32", spawnFn });

    expect(calls).toEqual([{ windowsHide: true }, { windowsHide: false }]);
    expect(child.pid).toBe(4242);
  });

  it("on POSIX, never retries — windowsHide is irrelevant there and a single failure is real", async () => {
    const calls: Array<{ windowsHide: unknown }> = [];
    const spawnFn = ((_command: string, _args: string[], options: { windowsHide: unknown }) => {
      calls.push({ windowsHide: options.windowsHide });
      const child = new FakeChild();
      queueMicrotask(() =>
        child.emit("error", Object.assign(new Error("EINVAL"), { code: "EINVAL" })),
      );
      return child;
    }) as any;

    await expect(
      spawnDetachedOrThrow(["fake-arg"], {}, { platform: "linux", spawnFn }),
    ).rejects.toThrow(/EINVAL/);
    expect(calls).toEqual([{ windowsHide: true }]);
  });

  it("on Windows, a non-EINVAL failure on the first attempt does not retry", async () => {
    const calls: Array<{ windowsHide: unknown }> = [];
    const spawnFn = ((_command: string, _args: string[], options: { windowsHide: unknown }) => {
      calls.push({ windowsHide: options.windowsHide });
      const child = new FakeChild();
      queueMicrotask(() =>
        child.emit("error", Object.assign(new Error("ENOENT"), { code: "ENOENT" })),
      );
      return child;
    }) as any;

    await expect(
      spawnDetachedOrThrow(["fake-arg"], {}, { platform: "win32", spawnFn }),
    ).rejects.toThrow(/ENOENT/);
    expect(calls).toEqual([{ windowsHide: true }]);
  });
});
