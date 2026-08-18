import "server-only";

/**
 * Machine bridge WS endpoint (task #7) — accepts the outbound dial from
 * `acprouter-cli`. Spec §5.1/§5.4: the connecting socket is the MACHINE
 * playing ACP AGENT; this server plays ACP CLIENT on it. Direction of the WS
 * handshake and ACP role are independent — `acp-ws-stream.ts` is the ~50
 * lines that make that true, proven by its own integration test and reused
 * here unmodified.
 *
 * Machines connect with:
 *   ws://<router>/api/machines/bridge?machineId=<id>
 *
 * No bearer credential (spec §8.1 — the OSS edition ships with no login):
 * the `machineId` itself, obtainable only from that machine's own successful
 * `POST /api/v1/machines/redeem` call, IS the credential for this MVP — see
 * `machine-bridge-connection.ts`'s doc comment for the full trust-model
 * reasoning. This route is deliberately thin (DDD convention): the
 * handshake, the same-tick stream wiring, and the online/offline DB
 * bookkeeping all live in `@acprouter/core`.
 */

import { acceptMachineBridgeConnection, runWithLocalContext } from "@acprouter/core";
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

export function UPGRADE(
  client: WebSocket,
  _server: import("ws").WebSocketServer,
  request: NextRequest,
  _context: RouteContext<"/api/machines/bridge">,
) {
  // `acceptMachineBridgeConnection` wires the socket's message listener
  // SYNCHRONOUSLY, before doing anything async — see that function's doc
  // comment for the full same-tick story (the same bug class the sibling
  // `/api/acp` route's doc comment documents hitting and fixing). What
  // matters here is only: `getDb()` is called but NOT awaited, so this whole
  // handler body runs synchronously in the tick `UPGRADE` is invoked in —
  // an `await getDb()` before calling `acceptMachineBridgeConnection` would
  // reintroduce exactly the bug this comment is warning against.
  //
  // `runWithLocalContext` wraps only THIS setup call (`storage.run` invokes
  // its callback synchronously, so it doesn't reintroduce the same bug).
  // It does NOT cover the connection's long-lived callbacks —
  // `onNotification`/`onRequest` in `machine-bridge-connection.ts`, or the
  // eventual `connection.closed` cleanup — which fire later, off the ACP SDK's
  // own event plumbing, not as a direct async continuation of this call.
  // Node's `AsyncLocalStorage` only guarantees propagation along a causal
  // async chain; whether a listener registered here still sees this store
  // when IT fires depends on internals this file shouldn't have to reason
  // about. It doesn't need to: this is a no-op today (`runWithLocalContext`
  // sets nothing), and the eventual hosted host (`runWithMemberContext`, not
  // wired up by this task) MUST NOT rely on ambient propagation into those
  // callbacks either — it should capture `resolveOwnerId()`/`getContextDb()`
  // synchronously here and pass them into `acceptMachineBridgeConnection`
  // explicitly, the same way `dbPromise` is already threaded through
  // explicitly today.
  const machineId = new URL(request.url).searchParams.get("machineId");
  void runWithLocalContext(async () => {
    acceptMachineBridgeConnection(getDb(), machineId, client);
  });
}
