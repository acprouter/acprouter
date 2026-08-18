import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const PID_FILENAME = "bridge.pid";
export const LOG_FILENAME = "bridge.log";
export const CONFIG_FILENAME = "config.json";

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
  writeFileSync(configFilePath(home), `${JSON.stringify(config, null, 2)}\n`);
}
