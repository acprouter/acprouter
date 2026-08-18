import type { ClientConnection } from "@agentclientprotocol/sdk";

/**
 * In-memory registry of live Router↔machine ACP connections (task #7), one
 * per connected machine — spec §5.4's "one socket per registered agent"
 * collapses to "one socket per machine" for the MVP, since task #8's
 * per-agent socket fan-out on top of one machine bridge doesn't exist yet.
 *
 * Stored on `globalThis`, not a module-level `Map` — same reasoning as this
 * package's own `db/index.ts`: Next.js dev mode (on-demand, per-route lazy
 * compilation) can re-evaluate a route handler's module graph independently
 * per importer, which would otherwise silently mint a second, empty registry
 * that the bridge WS route and any future session-routing code (task #8)
 * would disagree about — a real connection would be registered in one
 * instance and invisible from the other.
 *
 * NOT exported with `import "server-only"`: `@acprouter/cli` imports this
 * package's root barrel too (for `streamFromWebSocket`), and ESM re-exports
 * eagerly evaluate every module `index.ts` names — a `server-only` guard
 * anywhere in that chain would crash the CLI's plain Node process the
 * instant it imports `@acprouter/core`, regardless of whether it ever
 * touches this file's exports. This module has no actual server-only
 * concern (it's just a `Map`), so the guard was never needed here anyway.
 *
 * Single-process/single-instance, like the tunnel hub it mirrors (spec §5.4,
 * §9 OSS notes: "whatever we build inherits relaylib's single-process
 * ceiling"). Not a problem for a single self-hosted Router; documented here
 * so nobody rediscovers the ceiling by scaling to two replicas and getting
 * intermittent "machine shows online but nothing answers" failures.
 */
export interface MachineBridge {
  readonly connection: ClientConnection;
  readonly connectedAt: Date;
}

type GlobalWithMachineBridges = typeof globalThis & {
  __acprouterMachineBridges?: Map<string, MachineBridge>;
};

function getRegistry(): Map<string, MachineBridge> {
  const g = globalThis as GlobalWithMachineBridges;
  if (!g.__acprouterMachineBridges) {
    g.__acprouterMachineBridges = new Map();
  }
  return g.__acprouterMachineBridges;
}

export function registerMachineBridge(machineId: string, connection: ClientConnection): void {
  getRegistry().set(machineId, { connection, connectedAt: new Date() });
}

/**
 * Removes the registry entry only if it still points at THIS connection —
 * guards a reconnect race where a newer connection for the same machine
 * replaces the map entry before the OLDER connection's own close handler
 * runs; without the identity check, the older handler would delete the
 * newer, still-live entry out from under it.
 */
export function unregisterMachineBridge(machineId: string, connection: ClientConnection): void {
  const registry = getRegistry();
  if (registry.get(machineId)?.connection === connection) {
    registry.delete(machineId);
  }
}

export function getMachineBridge(machineId: string): MachineBridge | undefined {
  return getRegistry().get(machineId);
}
