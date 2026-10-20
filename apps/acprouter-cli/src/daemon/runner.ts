import { appendFileSync, writeFileSync } from "node:fs";
import {
  ensureAcprouterHome,
  HEARTBEAT_INTERVAL_MS,
  logFilePath,
  pidFilePath,
  readDeviceConfig,
  resolveAcprouterHome,
  writeHeartbeat,
} from "../config";
import { startBridgeConnection } from "./bridge-connection";
import { rotateLogIfNeeded } from "./local-daemon";

function timestamp(): string {
  return new Date().toISOString();
}

/**
 * The bridge process body — what actually runs once `local-daemon.ts` spawns
 * `RUN_BRIDGE_COMMAND`. Task #3 proved the process lifecycle (detach, PID
 * file, logging, graceful shutdown) with a heartbeat stub; task #7 replaces
 * that stub with the real dial-out ACP transport (`bridge-connection.ts`) —
 * this machine plays ACP AGENT, reconnecting with backoff for as long as the
 * process lives, so `machines.list`'s `status` reflects whether the bridge
 * is actually connected right now, not just whether it was once redeemed.
 */
export function runBridgeProcess(): void {
  const home = resolveAcprouterHome();
  ensureAcprouterHome(home);
  const logPath = logFilePath(home);

  const log = (line: string) => {
    try {
      rotateLogIfNeeded(logPath);
      appendFileSync(logPath, `[${timestamp()}] ${line}\n`);
    } catch {
      // Nothing sane to do if the log itself can't be written — stdio is
      // ignored in detached mode, so there is no console to fall back to.
    }
  };

  writeFileSync(
    pidFilePath(home),
    JSON.stringify({ pid: process.pid, startedAt: timestamp() }, null, 2),
  );

  // Written immediately (before either branch below) and every
  // `HEARTBEAT_INTERVAL_MS` after — `resolveBridgeStatus` treats a heartbeat
  // older than `HEARTBEAT_STALE_MS` as `unresponsive` even when the PID
  // itself still answers signal-0. Writing one right away, synchronously
  // after the PID file above, means a `status` check immediately after
  // `connect` sees a fresh heartbeat rather than racing the first interval
  // tick. `isConnectedNow` starts as a constant `false` and is replaced with
  // the real bridge's `isConnected` once one exists (not in the "idling, no
  // config yet" branch).
  let isConnectedNow: () => boolean = () => false;
  writeHeartbeat(home, false);
  const heartbeatTimer = setInterval(
    () => writeHeartbeat(home, isConnectedNow()),
    HEARTBEAT_INTERVAL_MS,
  );

  const config = readDeviceConfig(home);
  if (!config) {
    // `runConnect` (spec §5.4b) always writes device config before starting
    // the bridge, so this only happens if `__run-bridge` were invoked
    // directly outside that flow. Nothing to dial — stay alive and answer
    // signals rather than exiting non-zero, matching the pre-task-7 stub's
    // posture for this same edge case.
    log("bridge started (no device config yet) — nothing to connect to, idling");
    const shutdown = (signal: string) => {
      log(`received ${signal}, shutting down`);
      clearInterval(heartbeatTimer);
      process.exit(0);
    };
    process.on("SIGTERM", () => shutdown("SIGTERM"));
    process.on("SIGINT", () => shutdown("SIGINT"));
    return;
  }

  log(`bridge started: server=${config.server} dir=${config.dir} machineId=${config.machineId}`);

  const bridge = startBridgeConnection(
    {
      server: config.server,
      machineId: config.machineId,
      dir: config.dir,
      intendedAgentSlug: config.intendedAgentSlug,
      authStatus: config.authStatus,
      bridgeCredential: config.bridgeCredential,
    },
    log,
  );
  isConnectedNow = () => bridge.isConnected();

  const shutdown = (signal: string) => {
    log(`received ${signal}, shutting down`);
    clearInterval(heartbeatTimer);
    // Close the WS connection gracefully before exiting so the Router sees
    // a clean close and flips this machine to offline promptly, rather than
    // waiting out `machine-bridge-connection.ts`'s side noticing the socket
    // just went dead.
    bridge
      .stop()
      .catch(() => undefined)
      .finally(() => process.exit(0));
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}
