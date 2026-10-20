import os from "node:os";
import { createInterface } from "node:readline/promises";
import {
  type AuthStatus,
  formatAuthStatus,
  readDeviceConfig,
  resolveAcprouterHome,
  writeDeviceConfig,
} from "../config";
import { probeAgentAuth } from "../daemon/auth-probe";
import { resolveLocalDaemonState, startDetached, startForeground } from "../daemon/local-daemon";
import { detectAgent } from "../detect";
import { printError, printResult } from "../output";
import { RedeemError, redeemEnrollmentToken } from "../redeem";
import { resolveCliVersion } from "../version";

export interface ConnectOptions {
  server?: string;
  token?: string;
  dir?: string;
  foreground?: boolean;
  json?: boolean;
  home?: string;
  /**
   * Test-only injection seam for task #6.1's re-enrollment confirmation
   * prompt — never a real CLI flag (task #6.2 explicitly keeps
   * `ConnectOptions` free of any new user-facing option). Defaults to a real
   * `node:readline/promises` prompt against the terminal. Not surfaced by
   * `cli.ts`'s Commander wiring at all.
   */
  confirm?: (question: string) => Promise<boolean>;
}

/** Real stdin confirmation — `y`/`yes` (case-insensitive) is the only accepted affirmative. */
async function promptConfirm(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(`${question} [y/N] `);
    return /^y(es)?$/i.test(answer.trim());
  } finally {
    rl.close();
  }
}

interface ConnectResult {
  action: "already_running" | "started" | "self_healed";
  server: string;
  dir: string;
  pid: number | null;
  logPath: string;
  /** Populated only on the first-time (redeeming) path — self-heal reuses whatever was detected then. */
  detection?: { slug: string; installed: boolean; version: string | null; reason: string | null };
  /** Set at first-time enrollment, then just re-reported by self-heal — see `DeviceConfig.authStatus`. */
  authStatus?: AuthStatus | null;
}

/**
 * Idempotent and re-runnable, per spec §5.4b: running `connect` again never
 * errors, never starts a second copy, and self-heals a registered-but-dead
 * bridge — the user's recovery action for anything is "run the same command
 * again."
 */
export async function runConnect(options: ConnectOptions): Promise<void> {
  const home = resolveAcprouterHome(options.home);
  const state = resolveLocalDaemonState(home);

  if (state.running) {
    const config = readDeviceConfig(home);
    printResult<ConnectResult>(
      {
        action: "already_running",
        server: config?.server ?? "unknown",
        dir: config?.dir ?? "unknown",
        pid: state.pidInfo?.pid ?? null,
        logPath: state.logPath,
      },
      options,
      (r) => [`Already connected. Server: ${r.server}. PID: ${r.pid}.`],
    );
    return;
  }

  const existing = readDeviceConfig(home);
  const selfHealing = existing !== null;
  let detection: ConnectResult["detection"];

  // Task #6.1: an existing config PLUS a freshly supplied `--token` means the
  // user is re-enrolling this machine — swapping its device identity for a
  // different one (a different grant, a different Router, or just a fresh
  // token after revoking the old one). That's materially different from the
  // ordinary self-heal case (no token, just restart a dead bridge against
  // the SAME already-stored identity), and silently overwriting a working
  // enrollment because a stale/copy-pasted token happened to be present on
  // the command line would be a real footgun — so this path alone requires
  // explicit confirmation before `redeemEnrollmentToken` is ever called.
  if (existing !== null && options.token) {
    const confirm = options.confirm ?? promptConfirm;
    const proceed = await confirm(
      `This machine is already connected to ${existing.server}. Re-enrolling with a new token will replace its stored identity. Continue?`,
    );
    if (!proceed) {
      printResult<{ action: "declined" }>({ action: "declined" }, options, () => [
        "Re-enrollment cancelled. Existing connection left untouched.",
      ]);
      return;
    }
  }

  // A redeem happens either on first-time setup (`!selfHealing`) or on a
  // confirmed re-enrollment (`existing !== null && options.token`, already
  // gated on explicit confirmation above) — in both cases a token was
  // supplied and must be redeemed before the stored config can change. A
  // bare self-heal (existing config, no token) skips this entirely and
  // falls straight through to restarting the bridge against the config
  // that's already on disk.
  const isReenrolling = existing !== null && Boolean(options.token);
  if (!selfHealing || isReenrolling) {
    if (!options.server || !options.token) {
      printError(
        "connect requires --server <url> and --token <one-time token> for first-time setup.",
        options,
      );
      process.exitCode = 1;
      return;
    }

    let redeemed: {
      machineId: string;
      intendedAgentSlug: string | null;
      bridgeCredential?: string;
    };
    try {
      redeemed = await redeemEnrollmentToken(
        options.server,
        options.token,
        os.hostname(),
        resolveCliVersion(),
      );
    } catch (error) {
      // Shows WHY in the terminal — "invalid_token"/"expired"/"already_used"
      // /"network_error" are each a distinct, actionable reason, never a
      // generic failure (spec §3, acceptance criterion 2/10). Critically,
      // nothing has been written to disk yet at this point — a failed
      // redeem (first-time OR re-enrollment) always leaves whatever
      // config/session already existed completely untouched.
      const message = error instanceof RedeemError ? error.message : String(error);
      printError(`Enrollment failed: ${message}`, options);
      process.exitCode = 1;
      return;
    }

    const dir = options.dir ?? process.cwd();

    // Detect NOW, at connect time — the whole point (task #6) is catching a
    // missing agent binary here, visibly, instead of failing later and
    // cryptically inside task #8's spawn step. This does not block the
    // connection itself: the bridge is still valid infrastructure even if
    // one agent isn't installed yet, and the user may install it moments
    // later — `agents ls` / `status` can re-check any time.
    if (redeemed.intendedAgentSlug) {
      detection = detectAgent(redeemed.intendedAgentSlug);
    }

    // The connect-time auth probe (task #9, spec §5.2a point 2 / acceptance
    // criterion 10) — only worth running once the binary is confirmed
    // installed, and only here, at first-time enrollment: this is "the
    // moment... while the user is still sitting at that machine's
    // terminal," not something self-healing re-runs on every restart.
    let authStatus: AuthStatus | null = null;
    if (redeemed.intendedAgentSlug && detection?.installed) {
      authStatus = await probeAgentAuth({
        registrySlug: redeemed.intendedAgentSlug,
        dir,
        log: (line) => console.error(`[auth] ${line}`),
      });
    }

    writeDeviceConfig(home, {
      server: options.server,
      machineId: redeemed.machineId,
      dir,
      connectedAt: new Date().toISOString(),
      intendedAgentSlug: redeemed.intendedAgentSlug,
      authStatus,
      bridgeCredential: redeemed.bridgeCredential,
    });
  }

  const config = readDeviceConfig(home);
  if (!config) {
    printError("Failed to persist device config.", options);
    process.exitCode = 1;
    return;
  }

  if (options.foreground) {
    const code = await startForeground({ home });
    process.exitCode = code;
    return;
  }

  try {
    const started = await startDetached({ home });
    printResult<ConnectResult>(
      {
        // A confirmed re-enrollment redeemed a brand-new token and
        // overwrote the stored config, same as first-time `started` — only
        // a bare restart against an unchanged, already-stored config is a
        // genuine "self_healed".
        action: selfHealing && !isReenrolling ? "self_healed" : "started",
        server: config.server,
        dir: config.dir,
        pid: started.pid,
        logPath: started.logPath,
        detection,
        // Self-heal never re-probes (see comment above); this is whatever
        // the original first-time `connect` stored, read back from disk —
        // acceptance criterion 10's "later, run status/agents ls and still
        // see it" case, applied to `connect` re-runs too.
        authStatus: config.authStatus,
      },
      options,
      (r) => {
        const lines = [
          `${r.action === "self_healed" ? "Reconnected" : "Connected"}. Server: ${r.server}. Dir: ${r.dir}. PID: ${r.pid}.`,
          `Logs: ${r.logPath}`,
        ];
        if (r.detection && !r.detection.installed) {
          lines.push(`Warning: ${r.detection.slug} not detected — ${r.detection.reason}`);
        } else if (r.detection?.installed) {
          lines.push(`Detected ${r.detection.slug}: ${r.detection.version ?? "installed"}`);
        }
        if (r.authStatus) lines.push(formatAuthStatus(r.authStatus));
        return lines;
      },
    );
  } catch (error) {
    printError(error instanceof Error ? error.message : String(error), options);
    process.exitCode = 1;
  }
}
