/**
 * In-memory registry of live external-consumer ACP connections (Codex
 * interim review blocker 2), keyed by the consumer API key's own `id` (not
 * `agentId`): an agent can have several independently-minted consumer keys,
 * each independently revocable, and revoking ONE must never touch a live
 * connection authenticated by a DIFFERENT key for the same agent. Mirrors
 * `machine-bridge-registry.ts`'s `globalThis`-backed storage (survives
 * Next.js dev's per-route lazy module re-evaluation, same single-process
 * ceiling) but NOT its one-entry-per-key shape: a single key can legitimately
 * authenticate more than one simultaneous socket (a client reconnecting
 * before its old socket's close event has fired, or genuinely more than one
 * process holding the same credential), so each key maps to a `Set` of
 * sockets, not a single socket — closing a key must close ALL of them, never
 * silently orphaning everything but the most-recently-registered one.
 *
 * This is what makes a long-lived `wss://.../api/acp?agentId=...` connection
 * actually stop working the moment its key is revoked, instead of staying
 * silently connected until the socket happens to die on its own — without
 * this registry, `revokeConsumerApiKey`/the grant-revocation cascade had no
 * handle on any already-accepted WebSocket to close.
 *
 * Unlike `machine-bridge-registry.ts` (where the Router plays ACP CLIENT and
 * `acp.client(...)` itself IS a `ClientConnection` with a `.closed` promise),
 * here the Router plays ACP AGENT: `AcpServer.prepareWebSocketUpgrade()
 * .accept()` returns `void`, exposing no connection handle at all. The only
 * handle that exists for this leg is the raw `ws` socket the route's
 * `UPGRADE` handler already has — the same one `ws-keepalive.ts` pings — so
 * this registry is keyed around that, structurally typed exactly like
 * `KeepaliveWebSocketLike` rather than importing `ws` for one method.
 */
export interface ConsumerAcpSocketLike {
  close(code?: number, reason?: string): void;
}

interface ConsumerAcpConnectionEntry {
  readonly socket: ConsumerAcpSocketLike;
  readonly agentId: string;
  readonly connectedAt: Date;
}

type GlobalWithConsumerAcpConnections = typeof globalThis & {
  __acprouterConsumerAcpConnections?: Map<string, Set<ConsumerAcpConnectionEntry>>;
};

function getRegistry(): Map<string, Set<ConsumerAcpConnectionEntry>> {
  const g = globalThis as GlobalWithConsumerAcpConnections;
  if (!g.__acprouterConsumerAcpConnections) {
    g.__acprouterConsumerAcpConnections = new Map();
  }
  return g.__acprouterConsumerAcpConnections;
}

export function registerConsumerAcpConnection(
  keyId: string,
  agentId: string,
  socket: ConsumerAcpSocketLike,
): void {
  const registry = getRegistry();
  const entries = registry.get(keyId) ?? new Set();
  entries.add({ socket, agentId, connectedAt: new Date() });
  registry.set(keyId, entries);
}

/**
 * Removes only THIS socket's own entry — a key with multiple live sockets
 * must keep tracking its other, still-open ones. Deletes the key's `Set`
 * entirely once it's empty, so a since-closed key with zero sockets doesn't
 * linger in the map forever.
 */
export function unregisterConsumerAcpConnection(
  keyId: string,
  socket: ConsumerAcpSocketLike,
): void {
  const registry = getRegistry();
  const entries = registry.get(keyId);
  if (!entries) return;
  for (const entry of entries) {
    if (entry.socket === socket) {
      entries.delete(entry);
      break;
    }
  }
  if (entries.size === 0) registry.delete(keyId);
}

/** Every live `(socket, agentId, connectedAt)` entry currently registered under this key, if any. */
export function getConsumerAcpConnections(
  keyId: string,
): ReadonlySet<ConsumerAcpConnectionEntry> | undefined {
  return getRegistry().get(keyId);
}

/** All live `(keyId, entries)` pairs — the <=60s reconciliation sweep's own read path. */
export function listConsumerAcpConnections(): ReadonlyMap<
  string,
  ReadonlySet<ConsumerAcpConnectionEntry>
> {
  return getRegistry();
}

/**
 * Closes and unregisters EVERY live connection for a specific revoked key —
 * the actual enforcement half of "revoke-aware closing". No-op (not an
 * error) if no connection is currently registered for this key, which is the
 * common case (most revokes happen against an idle key with no open socket).
 *
 * Each socket's own `close()` is isolated with try/catch — one socket
 * throwing (an already-dead/half-closed connection, a buggy client transport)
 * must never stop this from closing every OTHER socket under the same key,
 * nor from clearing the registry entry afterward.
 */
export function closeConsumerAcpConnection(keyId: string, reason: string): void {
  const registry = getRegistry();
  const entries = registry.get(keyId);
  if (!entries) return;
  for (const entry of entries) {
    try {
      // 4001: private-use close code range (RFC 6455 §7.4.2) — "credential
      // revoked", distinct from a normal 1000 close so a well-behaved client
      // can tell "you were kicked" apart from "server shut down gracefully"
      // and knows not to blindly reconnect-with-backoff against the same key.
      entry.socket.close(4001, reason);
    } catch (error) {
      console.error(
        `[acprouter] failed to close consumer ACP socket for keyId=${keyId}: ${String(error)}`,
      );
    }
  }
  registry.delete(keyId);
}
