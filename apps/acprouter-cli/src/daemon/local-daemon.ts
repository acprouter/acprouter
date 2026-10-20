import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, readFileSync, renameSync, statSync, unlinkSync } from "node:fs";
import {
  ensureAcprouterHome,
  HEARTBEAT_STALE_MS,
  LOG_BACKUP_COUNT,
  LOG_MAX_BYTES,
  logFilePath,
  pidFilePath,
  readHeartbeat,
  resolveAcprouterHome,
} from "../config";

/**
 * The hidden subcommand the bridge re-invokes itself with when spawned.
 *
 * Rather than resolving a separate compiled runner file (fragile across dev
 * mode/tsx vs. the tsup-bundled dist, where relative `import.meta.url` paths
 * resolve differently before and after bundling), the bridge process is just
 * the CLI re-executing itself: `spawn(process.execPath, [...process.execArgv,
 * process.argv[1], RUN_BRIDGE_COMMAND])`. `process.argv[1]` is whatever
 * script the user actually ran, and forwarding `process.execArgv` carries
 * tsx's loader hook through to the child in dev mode — the same trick other
 * self-re-exec daemon CLIs use to survive the dev/bundled split.
 */
export const RUN_BRIDGE_COMMAND = "__run-bridge";

/** Grace period after a detached spawn before we declare it "started". */
const DETACHED_STARTUP_GRACE_MS = 1000;
/** Default time to wait for a graceful SIGTERM exit before `--force` escalates. */
export const DEFAULT_STOP_TIMEOUT_MS = 15_000;
const KILL_GRACE_MS = 3000;

export interface PidInfo {
  pid: number;
  startedAt: string;
}

/**
 * The four states a bridge can be in — collapsing "stale PID file" and
 * "unresponsive" into a single "not running" loses exactly the distinction
 * that makes a status command trustworthy (spec §5.4b, modelled on the same
 * PID-file-vs-liveness-check pattern other local daemon CLIs use).
 */
export type BridgeStatus = "running" | "stopped" | "stale_pid" | "unresponsive";

export interface LocalDaemonState {
  home: string;
  pidPath: string;
  logPath: string;
  pidInfo: PidInfo | null;
  running: boolean;
  stalePidFile: boolean;
  /** `false` when the PID is alive but its heartbeat is missing or older than `HEARTBEAT_STALE_MS` — a hung event loop, not a dead process. */
  heartbeatFresh: boolean;
}

export interface DetachedStartResult {
  pid: number | null;
  logPath: string;
}

function readPidFile(path: string): PidInfo | null {
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    if (typeof parsed?.pid !== "number") return null;
    return { pid: parsed.pid, startedAt: parsed.startedAt ?? "unknown" };
  } catch {
    return null;
  }
}

/** `process.kill(pid, 0)` throws if the process doesn't exist or we lack permission — a pure liveness probe. */
export function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Signals the whole process group, not just the daemon's own pid.
 *
 * `spawn(..., { detached: true })` makes the child the leader of a new
 * process group on POSIX (its pgid equals its pid), so `-pid` reaches every
 * descendant it spawns. This is what makes `--force` a real "process tree"
 * kill without a `tree-kill` dependency, and it is the invariant task #8's
 * per-session agent processes will rely on.
 */
function signalProcessGroup(pid: number, signal: NodeJS.Signals): boolean {
  try {
    process.kill(process.platform === "win32" ? pid : -pid, signal);
    return true;
  } catch {
    return false;
  }
}

function removeStalePidFile(pidPath: string): void {
  try {
    unlinkSync(pidPath);
  } catch {
    // Already gone — fine.
  }
}

/**
 * Renames `bridge.log` → `.1` → `.2` (oldest dropped) once it crosses
 * `maxBytes`, so a long-lived bridge never grows an unbounded log file.
 * Synchronous, matching `runner.ts`'s existing `appendFileSync` — the log
 * write itself is already sync, and rotation only ever runs immediately
 * before it, so there is no new blocking behavior introduced here, just a
 * cheap `statSync` on the common (no rotation needed) path.
 */
export function rotateLogIfNeeded(
  logPath: string,
  maxBytes: number = LOG_MAX_BYTES,
  backupCount: number = LOG_BACKUP_COUNT,
): boolean {
  let size: number;
  try {
    size = statSync(logPath).size;
  } catch {
    return false; // No log file yet — nothing to rotate.
  }
  if (size < maxBytes) return false;

  try {
    unlinkSync(`${logPath}.${backupCount}`);
  } catch {
    // Already gone, or never existed — fine either way.
  }
  for (let index = backupCount - 1; index >= 1; index -= 1) {
    try {
      renameSync(`${logPath}.${index}`, `${logPath}.${index + 1}`);
    } catch {
      // That backup slot didn't exist yet — fine, nothing to shift.
    }
  }
  try {
    renameSync(logPath, `${logPath}.1`);
  } catch {
    return false; // Lost a race with something else touching the file — next check will retry.
  }
  return true;
}

export function tailLog(home?: string, lines = 30): string | null {
  const logPath = logFilePath(resolveAcprouterHome(home));
  if (!existsSync(logPath)) return null;
  const content = readFileSync(logPath, "utf8").split("\n");
  return content.slice(-lines).join("\n");
}

function isHeartbeatFresh(home: string): boolean {
  const heartbeat = readHeartbeat(home);
  if (!heartbeat) return false;
  const age = Date.now() - new Date(heartbeat.updatedAt).getTime();
  return Number.isFinite(age) && age <= HEARTBEAT_STALE_MS;
}

export function resolveLocalDaemonState(home?: string): LocalDaemonState {
  const resolvedHome = resolveAcprouterHome(home);
  const pidPath = pidFilePath(resolvedHome);
  const logPath = logFilePath(resolvedHome);
  const pidInfo = readPidFile(pidPath);
  const running = pidInfo ? isProcessRunning(pidInfo.pid) : false;

  return {
    home: resolvedHome,
    pidPath,
    logPath,
    pidInfo,
    running,
    stalePidFile: Boolean(pidInfo) && !running,
    // Only meaningful while `running` — no point reading a heartbeat file
    // for a PID that's already confirmed dead.
    heartbeatFresh: running ? isHeartbeatFresh(resolvedHome) : false,
  };
}

/**
 * Named status a human reads, distinct from the boolean `running` other
 * callers key off of: `stale_pid` (a PID file survives a crashed process)
 * and `unresponsive` (alive by signal-0 but not answering) must never both
 * collapse into "not running" — that is the whole point of this type.
 *
 * `unresponsive` is decided by heartbeat freshness (`runner.ts` writes one
 * every `HEARTBEAT_INTERVAL_MS`; `isHeartbeatFresh` above reads it), not by
 * probing the actual bridge↔Router connection — a reconnect backoff in
 * progress is normal and must NOT read as unresponsive, but a heartbeat that
 * has stopped ticking altogether means the process's own event loop is
 * hung, which a signal-0 probe can never see (the OS still schedules a
 * stuck process; it just isn't doing anything).
 */
export function resolveBridgeStatus(state: LocalDaemonState): BridgeStatus {
  if (state.running) return state.heartbeatFresh ? "running" : "unresponsive";
  if (state.stalePidFile) return "stale_pid";
  return "stopped";
}

export interface StartOptions {
  home?: string;
}

function getErrorCode(error: unknown): string {
  return typeof error === "object" && error !== null && "code" in error
    ? String((error as { code: unknown }).code)
    : "UNKNOWN";
}

/** Resolves once the child either genuinely spawns or the OS-level `spawn()` call itself fails (e.g. `EINVAL`) — distinct from the child later exiting on its own. */
function waitForSpawnOrError(child: ChildProcess): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => {
      child.off("spawn", onSpawn);
      reject(error);
    };
    const onSpawn = () => {
      child.off("error", onError);
      resolve();
    };
    child.once("error", onError);
    child.once("spawn", onSpawn);
  });
}

export interface SpawnDetachedDependencies {
  platform?: NodeJS.Platform;
  /** Injectable so the Windows `EINVAL` retry path is unit-testable without an actual Windows machine. */
  spawnFn?: typeof spawn;
}

/**
 * `windowsHide: true` (the default we want, so a detached bridge never
 * flashes a console window) has a known Node/Windows combination that fails
 * the underlying spawn syscall with `EINVAL` — retrying once with
 * `windowsHide: false` on that specific failure is the same fallback
 * `apps/buda-connector/src/daemon-client.ts`'s `spawnDetachedDaemonProcess`
 * uses for the identical problem. A no-op on POSIX: `windowsHide` has no
 * meaning there, so the single attempt always applies and either succeeds or
 * fails for an unrelated reason (nothing left to retry into).
 */
export async function spawnDetachedOrThrow(
  args: string[],
  env: NodeJS.ProcessEnv,
  dependencies: SpawnDetachedDependencies = {},
): Promise<ChildProcess> {
  const platform = dependencies.platform ?? process.platform;
  const spawnFn = dependencies.spawnFn ?? spawn;
  const strategies = platform === "win32" ? [true, false] : [true];
  let lastError: unknown;
  for (const [index, windowsHide] of strategies.entries()) {
    const child = spawnFn(process.execPath, args, {
      detached: true,
      stdio: ["ignore", "ignore", "ignore"],
      windowsHide,
      env,
    });
    try {
      await waitForSpawnOrError(child);
      return child;
    } catch (error) {
      lastError = error;
      const shouldRetry =
        index < strategies.length - 1 && platform === "win32" && getErrorCode(error) === "EINVAL";
      if (!shouldRetry) {
        throw new Error(`Bridge process creation failed: ${getErrorCode(error)}`, {
          cause: error,
        });
      }
      // Fall through to the next strategy (windowsHide: false).
    }
  }
  // Unreachable given `strategies` is always non-empty, but keeps the return type honest.
  throw new Error("Bridge process creation failed without a spawn attempt", { cause: lastError });
}

/**
 * Starts the bridge detached — `spawn(detached:true, stdio:ignore)` +
 * `unref()` so the CLI's own process can exit without taking the bridge
 * down, and the user's terminal is never held hostage (spec §5.4b).
 *
 * Waits a short grace period and, if the child exits within it, reports the
 * real reason plus the log tail rather than claiming "started ✓" over a
 * process that is already dead.
 */
export async function startDetached(options: StartOptions = {}): Promise<DetachedStartResult> {
  const home = resolveAcprouterHome(options.home);
  ensureAcprouterHome(home);
  const logPath = logFilePath(home);

  const child = await spawnDetachedOrThrow(
    [...process.execArgv, process.argv[1] ?? "", RUN_BRIDGE_COMMAND],
    { ...process.env, ACPROUTER_HOME: home },
  );
  child.unref();

  const outcome = await new Promise<{
    exitedEarly: boolean;
    code: number | null;
    signal: string | null;
  }>((resolve) => {
    let settled = false;
    const finish = (value: {
      exitedEarly: boolean;
      code: number | null;
      signal: string | null;
    }) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const timer = setTimeout(
      () => finish({ exitedEarly: false, code: null, signal: null }),
      DETACHED_STARTUP_GRACE_MS,
    );
    child.once("error", () => {
      clearTimeout(timer);
      finish({ exitedEarly: true, code: null, signal: null });
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      finish({ exitedEarly: true, code, signal });
    });
  });

  if (outcome.exitedEarly) {
    const reason = `exit code ${outcome.code ?? "unknown"}${outcome.signal ? ` (${outcome.signal})` : ""}`;
    const recentLogs = tailLog(home);
    throw new Error(
      [`Bridge failed to start (${reason}).`, recentLogs ? `Recent log:\n${recentLogs}` : null]
        .filter(Boolean)
        .join("\n\n"),
    );
  }

  return { pid: child.pid ?? null, logPath };
}

/** Runs the bridge in the foreground (`--foreground`) — inherits stdio, blocks until it exits. */
export function startForeground(options: StartOptions = {}): Promise<number> {
  const home = resolveAcprouterHome(options.home);
  ensureAcprouterHome(home);

  const child: ChildProcess = spawn(
    process.execPath,
    [...process.execArgv, process.argv[1] ?? "", RUN_BRIDGE_COMMAND],
    {
      stdio: "inherit",
      env: { ...process.env, ACPROUTER_HOME: home },
    },
  );

  return new Promise((resolve) => {
    child.once("exit", (code) => resolve(code ?? 0));
  });
}

export interface StopOptions {
  home?: string;
  timeoutMs?: number;
  force?: boolean;
  killTimeoutMs?: number;
}

export type StopResult =
  | { action: "not_running" }
  | { action: "stopped"; pid: number }
  | { action: "killed"; pid: number };

async function waitForExit(pid: number, timeoutMs: number): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (!isProcessRunning(pid)) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return !isProcessRunning(pid);
}

/** Graceful stop with timeout → `--force` escalates to SIGKILL over the process group. */
export async function stopDaemon(options: StopOptions = {}): Promise<StopResult> {
  const state = resolveLocalDaemonState(options.home);
  if (!state.pidInfo) return { action: "not_running" };

  const pid = state.pidInfo.pid;
  if (!isProcessRunning(pid)) {
    removeStalePidFile(state.pidPath);
    return { action: "not_running" };
  }

  signalProcessGroup(pid, "SIGTERM");
  const exitedGracefully = await waitForExit(pid, options.timeoutMs ?? DEFAULT_STOP_TIMEOUT_MS);
  if (exitedGracefully) {
    removeStalePidFile(state.pidPath);
    return { action: "stopped", pid };
  }

  if (!options.force) {
    throw new Error(
      `Bridge (PID ${pid}) did not stop within the timeout. Re-run with --force to send SIGKILL.`,
    );
  }

  signalProcessGroup(pid, "SIGKILL");
  const killed = await waitForExit(pid, options.killTimeoutMs ?? KILL_GRACE_MS);
  removeStalePidFile(state.pidPath);
  if (!killed) {
    throw new Error(`Bridge (PID ${pid}) did not exit even after SIGKILL.`);
  }
  return { action: "killed", pid };
}
