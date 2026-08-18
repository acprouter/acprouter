import {
  type AuthStatus,
  formatAuthStatus,
  readDeviceConfig,
  resolveAcprouterHome,
} from "../config";
import { type DetectionResult, detectAllKnownAgents } from "../detect";
import { printResult } from "../output";

export interface AgentsLsOptions {
  json?: boolean;
  home?: string;
}

interface AgentsLsEntry extends DetectionResult {
  /** Only set for `config.intendedAgentSlug` — the one agent this machine is actually bridging. */
  authStatus?: AuthStatus | null;
}

/**
 * Real detection (task #6) — what this machine actually has, not a catalog
 * fetch — plus whatever sign-in status `connect` recorded (task #9) for the
 * one agent this machine is actually bridging, so a user who skipped
 * sign-in at enrollment sees "sign-in needed" again here, not silence.
 */
export function runAgentsLs(options: AgentsLsOptions): void {
  const home = resolveAcprouterHome(options.home);
  const config = readDeviceConfig(home);
  const agents: AgentsLsEntry[] = detectAllKnownAgents().map((a) =>
    a.slug === config?.intendedAgentSlug ? { ...a, authStatus: config.authStatus } : a,
  );

  printResult({ agents }, options, (r) =>
    r.agents.map((a) => {
      const line = a.installed
        ? `${a.slug}: installed (${a.version ?? "unknown version"})`
        : `${a.slug}: not found — ${a.reason}`;
      return a.authStatus ? `${line} — ${formatAuthStatus(a.authStatus)}` : line;
    }),
  );
}
