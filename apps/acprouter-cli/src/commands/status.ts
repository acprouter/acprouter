import {
  type AuthStatus,
  formatAuthStatus,
  readDeviceConfig,
  resolveAcprouterHome,
} from "../config";
import { resolveBridgeStatus, resolveLocalDaemonState } from "../daemon/local-daemon";
import { detectAgent } from "../detect";
import { printResult } from "../output";

export interface StatusOptions {
  json?: boolean;
  home?: string;
}

interface StatusResult {
  status: "running" | "stopped" | "stale_pid" | "unresponsive";
  pid: number | null;
  server: string | null;
  dir: string | null;
  logPath: string;
  /** Live-checked, not cached from connect time — an install can change at any moment. */
  detection?: { slug: string; installed: boolean; version: string | null; reason: string | null };
  /** Whatever `connect` recorded at first-time enrollment (task #9) — not re-probed here. */
  authStatus?: AuthStatus | null;
}

const STATUS_LABEL: Record<StatusResult["status"], string> = {
  running: "Running",
  stopped: "Not running",
  stale_pid: "Not running (stale PID file — a previous bridge crashed without cleaning up)",
  unresponsive: "Unresponsive (process alive but not answering)",
};

export function runStatus(options: StatusOptions): void {
  const home = resolveAcprouterHome(options.home);
  const state = resolveLocalDaemonState(home);
  const config = readDeviceConfig(home);

  const result: StatusResult = {
    status: resolveBridgeStatus(state),
    pid: state.pidInfo?.pid ?? null,
    server: config?.server ?? null,
    dir: config?.dir ?? null,
    logPath: state.logPath,
    detection: config?.intendedAgentSlug ? detectAgent(config.intendedAgentSlug) : undefined,
    authStatus: config?.authStatus,
  };

  printResult(result, options, (r) => {
    const lines = [STATUS_LABEL[r.status]];
    if (r.pid) lines.push(`PID: ${r.pid}`);
    if (r.server) lines.push(`Server: ${r.server}`);
    if (r.dir) lines.push(`Dir: ${r.dir}`);
    if (r.detection) {
      lines.push(
        r.detection.installed
          ? `${r.detection.slug}: installed (${r.detection.version ?? "unknown version"})`
          : `${r.detection.slug}: not detected — ${r.detection.reason}`,
      );
    }
    if (r.authStatus) lines.push(formatAuthStatus(r.authStatus));
    lines.push(`Logs: ${r.logPath}`);
    return lines;
  });
}
