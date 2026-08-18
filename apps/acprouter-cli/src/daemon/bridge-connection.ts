// Imported from the dedicated `@acprouter/core/acp-ws-stream` subpath, NOT
// the package root: this bridge process is spawned fresh (via `tsx`, cold,
// no build cache) on every `connect`/`restart`, and it must write its PID
// file within `local-daemon.ts`'s 1s startup-grace window. The root barrel
// re-exports `agentsRouter`/`machines-logic`/`registry-sync`, which pull in
// drizzle-orm, postgres, @electric-sql/pglite, and @orpc/server — none of
// which this process needs, and loading that whole graph cold measurably
// blew past the grace window under load, intermittently failing
// `local-daemon.integration.test.ts`'s existing PID-file assertions (a real
// regression this task caused and had to fix, not a hypothetical). This
// adapter itself has zero runtime dependencies beyond a type-only import, so
// this subpath is the actual lightweight boundary the task brief asked to
// verify before assuming the root export was fine to use here.
import { streamFromWebSocket } from "@acprouter/core/acp-ws-stream";
import { startWebSocketKeepalive } from "@acprouter/core/ws-keepalive";
import { WebSocket } from "ws";
import type { AuthStatus } from "../config";
import { createBridgeAgentApp } from "./bridge-agent";
import { toBridgeWebSocketUrl } from "./bridge-url";

const INITIAL_BACKOFF_MS = 1000;
const MAX_BACKOFF_MS = 30_000;

export interface BridgeConnectionHandle {
  /** Stops reconnecting and closes whatever is currently open. Resolves once the socket is closed. */
  stop(): Promise<void>;
}

export interface BridgeConnectionConfig {
  server: string;
  machineId: string;
  dir: string;
  /** Forwarded to `createBridgeAgentApp` so every `initialize` response can report them (task #10). */
  intendedAgentSlug: string | null;
  authStatus?: AuthStatus | null;
}

/**
 * Dials the Router and holds the ACP agent-role connection open for as long
 * as the bridge process runs, reconnecting with exponential backoff (capped
 * at 30s) on any drop — Router restart, network blip, laptop sleep/wake.
 * Never gives up permanently: the bridge's whole reason to exist is staying
 * reachable, so a terminal failure state here would silently turn "online"
 * into "stuck offline forever" (spec §3's failure modes), which is strictly
 * worse than a card that stays red while retrying.
 *
 * One `AgentApp` (built once) serves every reconnect attempt — `connect()`
 * on it is what produces a fresh per-socket `AgentConnection` each time, the
 * same way `AcpServer` on the Router side reuses one agent/handler set
 * across many accepted sockets.
 */
export function startBridgeConnection(
  config: BridgeConnectionConfig,
  log: (line: string) => void,
): BridgeConnectionHandle {
  const url = toBridgeWebSocketUrl(config.server, config.machineId);
  const bridgeAgent = createBridgeAgentApp({
    dir: config.dir,
    registrySlug: config.intendedAgentSlug,
    authStatus: config.authStatus ?? null,
    log,
  });
  const agentApp = bridgeAgent.app;

  let stopped = false;
  let backoffMs = INITIAL_BACKOFF_MS;
  let currentSocket: WebSocket | null = null;
  let connectionAttached = false;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  const scheduleReconnect = (reason: string) => {
    if (stopped) return;
    const delay = backoffMs;
    backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF_MS);
    log(`bridge disconnected (${reason}); reconnecting in ${delay}ms`);
    reconnectTimer = setTimeout(connect, delay);
  };

  function connect(): void {
    if (stopped) return;
    log(`bridge connecting to ${url}`);
    connectionAttached = false;
    const socket = new WebSocket(url);
    currentSocket = socket;

    // Wiring MUST happen synchronously inside the "open" listener, with no
    // `await` before it — the same same-tick requirement documented in
    // `packages/acprouter-core/src/domains/agents/logic/machine-bridge-connection.ts`
    // applies symmetrically to this side of the socket: the Router sends its
    // `initialize` request the instant ITS side opens, and a `message` frame
    // that arrives before this side's listener is attached is dropped, not
    // queued, hanging the handshake with no error either side.
    socket.once("open", () => {
      backoffMs = INITIAL_BACKOFF_MS;
      log("bridge connected; ACP agent handshake starting");
      const stream = streamFromWebSocket(socket);
      const connection = agentApp.connect(stream);
      connectionAttached = true;
      // task #11, acceptance criterion 4, spec §5.5a — mutual with the
      // Router's own keepalive on this same socket (`machine-bridge-connection.ts`):
      // this side pings the Router so a dead/unresponsive Router is detected
      // and reconnected-from just as promptly as the Router detects a dead
      // machine, rather than only one direction noticing.
      const stopKeepalive = startWebSocketKeepalive(socket);
      connection.closed
        .catch(() => undefined)
        .finally(() => {
          stopKeepalive();
          if (currentSocket === socket) currentSocket = null;
          scheduleReconnect("acp connection closed");
        });
    });

    socket.once("error", (error) => {
      log(`bridge socket error: ${error instanceof Error ? error.message : String(error)}`);
      // "close" always follows "error" for `ws` — reconnect scheduling
      // happens from the "close" handler below, not here, to avoid
      // double-scheduling.
    });

    socket.once("close", (code, reasonBuf) => {
      if (currentSocket !== socket) return; // superseded by a newer attempt already
      currentSocket = null;
      if (!connectionAttached) {
        // Closed before the ACP layer ever attached (connection refused, DNS
        // failure, TLS error, or the Router rejected us pre-handshake) — the
        // `connection.closed` handler above never got wired, so nothing else
        // will schedule a retry.
        const reason = reasonBuf.toString("utf8");
        scheduleReconnect(`socket closed (${code}${reason ? ` ${reason}` : ""})`);
      }
    });
  }

  connect();

  return {
    async stop() {
      stopped = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      await bridgeAgent.disposeAllSessions();
      const socket = currentSocket;
      if (!socket) return;
      await new Promise<void>((resolve) => {
        socket.once("close", () => resolve());
        socket.close(1000, "bridge shutting down");
      });
    },
  };
}
