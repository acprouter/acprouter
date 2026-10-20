import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join } from "node:path";

export const PID_FILENAME = "bridge.pid";
export const LOG_FILENAME = "bridge.log";
export const CONFIG_FILENAME = "config.json";
export const HEARTBEAT_FILENAME = "bridge.heartbeat.json";

/**
 * How often the running bridge process touches its heartbeat file
 * (`runner.ts`). `resolveBridgeStatus` (`daemon/local-daemon.ts`) treats a
 * heartbeat older than `HEARTBEAT_STALE_MS` as "unresponsive" even though
 * the PID itself still answers signal-0 — the actual distinction that
 * status needs (a hung event loop, a deadlocked reconnect, anything short of
 * the process dying outright) is invisible to a liveness probe on the PID
 * alone.
 */
export const HEARTBEAT_INTERVAL_MS = 10_000;
/** 3x the write interval — generous enough that one slow tick never flaps the status. */
export const HEARTBEAT_STALE_MS = HEARTBEAT_INTERVAL_MS * 3;

/**
 * `bridge.log` used to grow without bound for as long as a bridge stayed
 * connected (`runner.ts` appends a line per reconnect/log event, and a
 * long-lived daemon reconnecting under a flaky network can log for months).
 * Same numeric thresholds `apps/buda-connector/src/logger.ts` uses — no
 * reason to pick different ones.
 */
export const LOG_MAX_BYTES = 2 * 1024 * 1024;
export const LOG_BACKUP_COUNT = 2;

/**
 * Result of the connect-time auth probe (task #9, spec §5.2a point 2 /
 * acceptance criterion 10). `"ok"` means a real `session/new` succeeded
 * against the freshly-spawned agent — no `auth_required` was ever seen.
 * `sign_in_needed`'s `detail` is always the acceptance criterion's "exact
 * next step" (which method was tried, or which env vars to set, or that the
 * agent gave no method at all), never a generic "please sign in".
 * `probe_failed` is reserved for a genuine error unrelated to auth (a crash,
 * a malformed response) — kept distinct so it is never shown as "sign-in
 * needed" for something that wasn't an auth problem.
 */
export type AuthStatus =
  | { state: "ok" }
  | { state: "sign_in_needed"; detail: string }
  | { state: "probe_failed"; detail: string };

/** Shared by `connect`/`status`/`agents ls` so the three commands never drift in wording. */
export function formatAuthStatus(status: AuthStatus): string {
  switch (status.state) {
    case "ok":
      return "Signed in.";
    case "sign_in_needed":
      return `Sign-in needed: ${status.detail}`;
    case "probe_failed":
      return `Could not check sign-in status: ${status.detail}`;
    default:
      return status satisfies never;
  }
}

export interface DeviceConfig {
  /** The Router this machine is bridged to. */
  server: string;
  /**
   * This machine's id, assigned by the Router when the enrollment token was
   * redeemed (task #5). The raw one-time token itself is never persisted —
   * it is single-use and already burned by the time this is written.
   */
  machineId: string;
  /** Absolute path the agent runs in — chosen locally, never by the server (spec §5.6/§8.2). */
  dir: string;
  connectedAt: string;
  /** Which catalog entry the dashboard's Add dialog was minting for, if any (spec §5.2/task #6). */
  intendedAgentSlug: string | null;
  /**
   * Set once, at first-time enrollment's connect-time auth probe (task #9)
   * — self-healing `connect` runs report this stored value rather than
   * re-probing (spec §5.2a: "the moment to authenticate is during connect",
   * meaning the first one). `null` when there was no `intendedAgentSlug` to
   * probe, or the binary wasn't installed yet (task #6 already reports
   * that failure on its own). Absent entirely on device configs written
   * before this task shipped.
   */
  authStatus?: AuthStatus | null;
  /**
   * Raw one-time bridge credential (task #6.4), sent back as an
   * `Authorization: Bearer` header when dialing the bridge WS — never
   * appended to the connection URL (query strings end up in proxy/server
   * access logs). Only present for `oauth-enrollment` machines; absent for
   * `legacy` ones and for any config written before this task shipped.
   * `writeDeviceConfig` tightens the file to owner-only permissions whenever
   * this field is set (task #6.3) — this is a live bearer credential, not a
   * burned one-time token.
   */
  bridgeCredential?: string;
}

export function resolveAcprouterHome(home?: string): string {
  return home ?? process.env.ACPROUTER_HOME ?? join(homedir(), ".acprouter");
}

export function ensureAcprouterHome(home: string): void {
  if (!existsSync(home)) mkdirSync(home, { recursive: true });
}

export function pidFilePath(home: string): string {
  return join(home, PID_FILENAME);
}

export function logFilePath(home: string): string {
  return join(home, LOG_FILENAME);
}

export function configFilePath(home: string): string {
  return join(home, CONFIG_FILENAME);
}

export function heartbeatFilePath(home: string): string {
  return join(home, HEARTBEAT_FILENAME);
}

export interface HeartbeatInfo {
  pid: number;
  updatedAt: string;
  /** Whether the ACP WebSocket to the Router is attached right now — diagnostic only; staleness of `updatedAt`, not this flag, decides `running` vs `unresponsive`. */
  connected: boolean;
}

/** Best-effort — a heartbeat write failing is never worth crashing the bridge over. */
export function writeHeartbeat(home: string, connected: boolean): void {
  try {
    const info: HeartbeatInfo = {
      pid: process.pid,
      updatedAt: new Date().toISOString(),
      connected,
    };
    writeFileSync(heartbeatFilePath(home), JSON.stringify(info, null, 2));
  } catch {
    // Nothing sane to do — see runner.ts's own log-write failure handling for the same posture.
  }
}

export function readHeartbeat(home: string): HeartbeatInfo | null {
  const path = heartbeatFilePath(home);
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    if (typeof parsed?.pid !== "number" || typeof parsed?.updatedAt !== "string") return null;
    return { pid: parsed.pid, updatedAt: parsed.updatedAt, connected: Boolean(parsed.connected) };
  } catch {
    return null;
  }
}

export function readDeviceConfig(home: string): DeviceConfig | null {
  const path = configFilePath(home);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as DeviceConfig;
  } catch {
    return null;
  }
}

export function writeDeviceConfig(home: string, config: DeviceConfig): void {
  ensureAcprouterHome(home);
  const path = configFilePath(home);
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`);
  // Task #6.3: a persisted bridge credential is a live bearer secret (unlike
  // the one-time enrollment token, which is already burned by the time this
  // is written) — the file must not be group- or world-readable. `chmod` is
  // a POSIX-only no-op on Windows (no equivalent bit to set here), which
  // matches this repo's existing platform posture elsewhere in this file.
  if (config.bridgeCredential && platform() !== "win32") {
    chmodSync(path, 0o600);
  }
}
