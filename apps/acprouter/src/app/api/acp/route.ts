import "server-only";

/**
 * External ACP consumer endpoint (task #14, spec §5.3 point 1 / §5.4):
 * `wss://<router>/api/acp?agentId=<id>` — matching how other ACP-native
 * consumers already expose this same shape is deliberate.
 *
 * Consumers connect with:
 *   wss://<router>/api/acp?agentId=<agents.id>
 *   Authorization: Bearer ack_...        (a consumer API key, task #14)
 *
 * This route is deliberately thin (DDD convention): the same-tick stream
 * wiring, the agent-role ACP handlers, and the credential check all live in
 * `@acprouter/core` (`consumer-acp-connection.ts`). What's left here is
 * `AcpServer.prepareWebSocketUpgrade().accept(client)`, called synchronously
 * with NO `await` beforehand, for a real reason worth stating explicitly:
 * a client always sends `initialize` the instant its `open` event fires,
 * and `ws`'s frame receiver starts
 * emitting `message` off an already-open socket with zero regard for whether
 * a listener exists yet — an `await` here (e.g. awaiting the API-key lookup
 * before accepting) would create a window where that first message is
 * silently dropped forever. Auth is resolved lazily instead:
 * `resolveConsumerAcpAuth(dbPromise, request)` is kicked off here unawaited,
 * and `createConsumerAcpAgentApp`'s `initialize` handler awaits it — by which
 * point the SDK is already listening, so nothing arriving in between is
 * lost, and a rejected/missing key surfaces as a normal JSON-RPC error
 * response to `initialize` rather than an opaque pre-upgrade close.
 *
 * Keepalive (task #14 point 4) is wired directly on the raw socket here,
 * not inside `consumer-acp-connection.ts` — `AcpServer.prepareWebSocketUpgrade
 * ().accept()` returns `void`, giving that module no connection handle of its
 * own to hook a "closed" cleanup on, whereas the raw `client` socket handed
 * to `UPGRADE` already exposes `close`/`error`, exactly like
 * `machine-bridge-connection.ts` does for the OTHER leg of this same
 * problem — reusing `ws-keepalive.ts` (task #11) rather than a second
 * implementation, per this task's own scope note.
 */

import {
  createConsumerAcpAgentApp,
  resolveConsumerAcpAuth,
  runWithLocalContext,
} from "@acprouter/core";
import { startWebSocketKeepalive } from "@acprouter/core/ws-keepalive";
import { AcpServer } from "@agentclientprotocol/sdk/experimental/server";
import type { NextRequest } from "next/server";
import type { RouteContext } from "next-ws/server";
import type WebSocket from "ws";
import { getDb } from "~/db";

export const GET = () =>
  new Response("WebSocket upgrade required", {
    status: 426,
    headers: {
      Connection: "Upgrade",
      Upgrade: "websocket",
    },
  });

// `runWithLocalContext` wraps only this synchronous setup call — see
// `apps/acprouter/src/app/api/machines/bridge/route.ts`'s UPGRADE handler for
// the full reasoning (same shape: a no-op today, and a future hosted host's
// long-lived `onNotification`/`onRequest`/close callbacks here must capture
// context values explicitly rather than assume ambient propagation across
// this connection's whole lifetime).
export function UPGRADE(
  client: WebSocket,
  _server: import("ws").WebSocketServer,
  request: NextRequest,
  _context: RouteContext<"/api/acp">,
) {
  void runWithLocalContext(async () => {
    const dbPromise = getDb();
    const identityPromise = resolveConsumerAcpAuth(dbPromise, request);
    const server = new AcpServer({ agent: createConsumerAcpAgentApp(dbPromise, identityPromise) });
    server.prepareWebSocketUpgrade().accept(client);

    const stopKeepalive = startWebSocketKeepalive(client);
    client.on("close", stopKeepalive);
  });
}
