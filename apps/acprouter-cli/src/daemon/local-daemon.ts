import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { ensureAcprouterHome, logFilePath, pidFilePath, resolveAcprouterHome } from "../config";

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

export function tailLog(home?: string, lines = 30): string | null {
  const logPath = logFilePath(resolveAcprouterHome(home));
  if (!existsSync(logPath)) return null;
  const content = readFileSync(logPath, "utf8").split("\n");
  return content.slice(-lines).join("\n");
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
  };
}

/**
 * Named status a human reads, distinct from the boolean `running` other
 * callers key off of: `stale_pid` (a PID file survives a crashed process)
 * and `unresponsive` (alive by signal-0 but not answering) must never both
 * collapse into "not running" — that is the whole point of this type.
 *
 * `unresponsive` is not reachable yet: distinguishing it from `running`
 * needs a liveness probe over the actual bridge↔Router connection, which
 * doesn't exist until task #7. The state stays in the type now so the
 * design doesn't have to be re-derived later, and `status`'s output wiring
 * (`commands/status.ts`) already has a label ready for it.
 */
export function resolveBridgeStatus(state: LocalDaemonState): BridgeStatus {
  if (state.running) return "running";
  if (state.stalePidFile) return "stale_pid";
  return "stopped";
}

export interface StartOptions {
  home?: string;
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

  const child = spawn(
    process.execPath,
    [...process.execArgv, process.argv[1] ?? "", RUN_BRIDGE_COMMAND],
    {
      detached: true,
      stdio: ["ignore", "ignore", "ignore"],
      env: { ...process.env, ACPROUTER_HOME: home },
    },
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
