import type { ClientConnection } from "@agentclientprotocol/sdk";
import type WebSocket from "ws";

/**
 * In-memory registry of live Router→`remote-acp` ACP connections (task
 * #13), one per SESSION — a deliberately different unit from
 * `machine-bridge-registry.ts`'s one-per-MACHINE. A `remote-acp` agent
 * (Buda) has no `machineId` to key on at all, but more importantly: Buda is
 * one stable, always-reachable server, not a laptop that sleeps or sits
 * behind NAT (spec §11 point 6's honest limits list, §5.2's "nothing to
 * launch — the agent already serves ACP over WebSocket"). There is no
 * NAT/sleep/reconnect problem here for a persistent-connection-plus-registry
 * to solve, so this file does NOT copy `machine-bridge-registry.ts`'s
 * reconnect/keepalive machinery — it just tracks "which socket is this
 * session's" for the lifetime of one prompt-box conversation, dialled fresh
 * in `sessions-logic.ts#startAgentSession` and torn down in `endAgentSession`.
 *
 * Same `globalThis`-caching reasoning as `machine-bridge-registry.ts`'s own
 * doc comment (Next.js dev-mode module-graph re-evaluation would otherwise
 * mint a second, empty registry that `startAgentSession` and
 * `promptAgentSession` would disagree about).
 */
export interface RemoteSessionConnection {
  readonly connection: ClientConnection;
  readonly socket: WebSocket;
  readonly connectedAt: Date;
}

type GlobalWithRemoteSessions = typeof globalThis & {
  __acprouterRemoteSessions?: Map<string, RemoteSessionConnection>;
};

function getRegistry(): Map<string, RemoteSessionConnection> {
  const g = globalThis as GlobalWithRemoteSessions;
  if (!g.__acprouterRemoteSessions) {
    g.__acprouterRemoteSessions = new Map();
  }
  return g.__acprouterRemoteSessions;
}

/** Called once `session/new` has returned a real `sessionId` — before this, the freshly dialled connection exists but is findable by nothing (see `sessions-logic.ts`'s `onSessionCreated`/`onSessionCreateFailed` split for why it can't be registered any earlier). */
export function registerRemoteSessionConnection(
  sessionId: string,
  connection: ClientConnection,
  socket: WebSocket,
): void {
  getRegistry().set(sessionId, { connection, socket, connectedAt: new Date() });
}

export function getRemoteSessionConnection(sessionId: string): RemoteSessionConnection | undefined {
  return getRegistry().get(sessionId);
}

/**
 * Actually closes the per-session socket and removes the registry entry —
 * called from `endAgentSession`'s `remote-acp` branch. Unlike a `bridged`
 * agent's shared, persistent bridge (which MUST outlive any one session,
 * since it serves every session on that machine), a `remote-acp` connection
 * belongs to exactly one session and has nothing left to do once that
 * session ends — leaving it open would leak a live WebSocket to Buda for
 * every prompt-box conversation anyone ever closed.
 */
export function closeRemoteSessionConnection(sessionId: string): void {
  const registry = getRegistry();
  const entry = registry.get(sessionId);
  if (!entry) return;
  registry.delete(sessionId);
  try {
    entry.connection.close();
  } catch {
    // Best-effort — the socket close below is what actually matters.
  }
  try {
    entry.socket.close();
  } catch {
    // Already closed (e.g. Buda closed it first) — fine.
  }
}
