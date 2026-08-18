import { type BridgeInitializeMeta, parseBridgeInitializeMeta } from "@acprouter/contract";
import * as acp from "@agentclientprotocol/sdk";
import type { Database } from "../../../db";
import type { AgentStatus } from "../schema/agents";
import { type OpenWebSocketLike, streamFromWebSocket } from "./acp-ws-stream";
import { markAgentsDisconnected, upsertBridgedAgent } from "./agents-logic";
import { registerMachineBridge, unregisterMachineBridge } from "./machine-bridge-registry";
import { getMachineOwnerId, markMachineOffline, markMachineOnline } from "./machines-logic";
import { displayNameForRegistrySlug } from "./registry-sync";
import {
  DEFAULT_PERMISSION_TIMEOUT_MS,
  emitSessionUpdate,
  requestSessionPermission,
} from "./session-relay-registry";
import { type KeepaliveWebSocketLike, startWebSocketKeepalive } from "./ws-keepalive";

/**
 * WS close codes this endpoint uses, in the 4000-4999 application-defined
 * range reserved by RFC 6455 §7.4.2 — mirrors `chrome-acp`'s `4001` for a
 * rejected token (spec §5.5a) rather than inventing a new scheme.
 */
export const MACHINE_BRIDGE_CLOSE_CODE = {
  missingMachineId: 4000,
  unknownMachine: 4001,
  initializeFailed: 4002,
} as const;

const INITIALIZE_TIMEOUT_MS = 10_000;

/**
 * Accepts one machine's dial-out bridge socket and plays the ACP CLIENT role
 * on it (spec §5.4 — the machine plays ACP AGENT; direction of the WS
 * handshake is independent of ACP role, proven in `acp-ws-stream.ts` and its
 * integration test). Called from the Next.js route's `UPGRADE` handler.
 *
 * MUST be called SYNCHRONOUSLY by the caller, with no `await` beforehand:
 * `streamFromWebSocket` attaches the socket's `message` listener in this
 * same call, before this function returns. `ws`'s frame receiver starts
 * emitting `message` the instant the socket is handed to us, regardless of
 * whether a listener exists yet — an emitted event with no listener is
 * dropped, not queued. If the caller awaited anything (e.g. resolving `db`)
 * before calling this, the machine's first frame (`initialize`'s response,
 * since the Router sends the request) could be lost and the connection
 * would hang forever with no error on either side. This is the exact bug
 * this Router's own `/api/acp` route documents hitting and fixing, and the
 * reason `dbPromise` below is a Promise rather than an already-resolved
 * `Database` — the caller kicks off `getDb()` unawaited and hands us the
 * promise so wiring the stream never waits on it.
 */
export function acceptMachineBridgeConnection(
  dbPromise: Promise<Database>,
  machineId: string | null,
  socket: OpenWebSocketLike & KeepaliveWebSocketLike,
  permissionTimeoutMs: number = DEFAULT_PERMISSION_TIMEOUT_MS,
): void {
  if (!machineId) {
    socket.close(MACHINE_BRIDGE_CLOSE_CODE.missingMachineId, "missing machineId query param");
    return;
  }

  const stream = streamFromWebSocket(socket);
  const connection = acp
    .client({ name: "acprouter" })
    .onNotification(acp.methods.client.session.update, (ctx) => {
      // task #11: routed to whichever browser tab is currently watching this
      // SESSION (not this machine — a machine can outlive many sessions), via
      // the in-memory relay registry. task #12: ALSO persisted regardless of
      // whether a browser is watching (`dbPromise`, not yet resolved `db` —
      // this handler is wired synchronously before `db` resolves, see this
      // function's own doc comment on that same constraint).
      emitSessionUpdate(dbPromise, ctx.params.sessionId, ctx.params.update);
    })
    .onRequest(acp.methods.client.session.requestPermission, (ctx) => {
      // task #11: replaces the old "auto-answer allow" placeholder — the
      // exact failure mode spec §3 calls "silent auto-approval" by name.
      // Routes the real options ACP offered to whichever browser tab is
      // watching this session (rendered as inline Allow/Deny-shaped cards),
      // and — regardless of whether anyone is watching — enforces the
      // 5-minute timeout (chrome-acp's reference number, spec §5.5a) so a
      // permission request nobody answers resolves `cancelled` rather than
      // hanging the spawned agent process forever. On that timeout, also
      // best-effort notifies `session/cancel` to the CLI so the agent's turn
      // actually stops instead of continuing unsupervised after one tool
      // call was silently denied out from under it.
      return requestSessionPermission(
        dbPromise,
        ctx.params.sessionId,
        ctx.params.toolCall,
        ctx.params.options,
        {
          timeoutMs: permissionTimeoutMs,
          onTimeout: () => {
            void connection.agent
              .notify(acp.methods.agent.session.cancel, { sessionId: ctx.params.sessionId })
              .catch(() => undefined);
          },
        },
      ).then((outcome) => ({ outcome }));
    })
    .connect(stream);

  void trackMachineBridgeConnection(dbPromise, machineId, connection, socket);
}

/**
 * Everything from here down is allowed to `await` — by the time this runs,
 * the stream returned by `streamFromWebSocket` is already buffering
 * incoming frames (a `ReadableStream` queues values from the moment its
 * controller exists, whether or not anything is reading from it yet), so
 * nothing sent by the machine while this function is still resolving `db`
 * or looking up the machine's owner is lost.
 */
async function trackMachineBridgeConnection(
  dbPromise: Promise<Database>,
  machineId: string,
  connection: acp.ClientConnection,
  socket: OpenWebSocketLike & KeepaliveWebSocketLike,
): Promise<void> {
  const db = await dbPromise;

  const ownerId = await getMachineOwnerId(db, machineId);
  if (ownerId === undefined) {
    // Close the SOCKET first, with our chosen code/reason, THEN tear down
    // the ACP connection object. `connection.close()` cancels the adapter's
    // `ReadableStream` reader synchronously, which calls `socket.close()`
    // with NO arguments (see `acp-ws-stream.ts`'s `cancel` handler) — a
    // WebSocket's close code is fixed by whichever `close()` call reaches it
    // first, so doing this in the other order would silently discard our
    // close code/reason in favor of an empty 1005 "no status" close. Found
    // by an actual close-code assertion failing in the integration test,
    // not by reading the SDK source in advance.
    socket.close(MACHINE_BRIDGE_CLOSE_CODE.unknownMachine, "unknown machineId");
    connection.close(new Error(`unknown machine: ${machineId}`));
    return;
  }

  const timeoutController = new AbortController();
  const timeout = setTimeout(() => timeoutController.abort(), INITIALIZE_TIMEOUT_MS);
  let initializeResult: acp.InitializeResponse;
  try {
    initializeResult = await connection.agent.request(
      acp.methods.agent.initialize,
      { protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: {} },
      { cancellationSignal: timeoutController.signal },
    );
  } catch (error) {
    // Same ordering requirement as the unknownMachine branch above.
    socket.close(MACHINE_BRIDGE_CLOSE_CODE.initializeFailed, "acp initialize failed");
    connection.close(error);
    return;
  } finally {
    clearTimeout(timeout);
  }

  await markMachineOnline(db, machineId);
  registerMachineBridge(machineId, connection);

  // task #11, acceptance criterion 4 — a sustained-output prompt is the
  // first thing this Router does that can leave the socket quiet for a
  // while between `session/update`s; started only once the handshake is
  // real (no point pinging a connection that hasn't proven itself yet), and
  // stopped in `connection.closed`'s cleanup below so it doesn't outlive
  // the socket.
  const stopKeepalive = startWebSocketKeepalive(socket);

  // Best-effort, never allowed to affect the connection's liveness: a
  // malformed `_meta` (old CLI, misbehaving CLI, or a future field this
  // build doesn't understand) or a DB hiccup here must not take down a
  // bridge that otherwise completed a real ACP handshake.
  await reportBridgedAgentFromInitialize(db, machineId, ownerId, initializeResult).catch(
    (error) => {
      console.error(
        `[acprouter] failed to record agent state for machine=${machineId}: ${String(error)}`,
      );
    },
  );

  connection.closed
    .catch(() => undefined)
    .finally(() => {
      stopKeepalive();
      unregisterMachineBridge(machineId, connection);
      // Best-effort: the socket is already gone, there is no one to report a
      // DB failure to. A future poll (task #8's heartbeat, if one is added)
      // is the backstop if this particular update is ever lost.
      void markMachineOffline(db, machineId).catch(() => undefined);
      // Same cascade for every agent this machine ever reported (task #10) —
      // a card must never keep reading "connected" once its machine is gone.
      void markAgentsDisconnected(db, machineId).catch(() => undefined);
    });
}

/**
 * Reads task #10's new `_meta` channel off a machine's `initialize`
 * response and upserts its `bridged` agent row. A `_meta` that doesn't parse
 * (see `parseBridgeInitializeMeta`'s contract) or carries no `registrySlug`
 * (a machine enrolled with no intended agent) means literally nothing to
 * report yet — not an error, and not a reason to leave a stale row behind
 * either, since there is no stale row until the first successful report.
 *
 * `ownerId` is the caller's already-resolved machine owner (see
 * `getMachineOwnerId` at the one call site) — this function never calls
 * `resolveOwnerId()` itself, since it runs from the bridge WS connection,
 * which has no session/actor context of its own.
 */
async function reportBridgedAgentFromInitialize(
  db: Database,
  machineId: string,
  ownerId: string,
  initializeResult: acp.InitializeResponse,
): Promise<void> {
  const meta = parseBridgeInitializeMeta(initializeResult._meta);
  if (!meta || !meta.registrySlug) return;

  await upsertBridgedAgent(db, {
    ownerId,
    machineId,
    registrySlug: meta.registrySlug,
    label: displayNameForRegistrySlug(meta.registrySlug),
    cwd: meta.cwd,
    detectedVersion: meta.detectedVersion,
    status: mapAuthStateToAgentStatus(meta.authState),
    statusDetail: meta.authDetail,
  });
}

/**
 * Maps the CLI's connect-time auth probe (task #9, `AuthStatus["state"]`)
 * onto this table's `AgentStatus`. A completed ACP `initialize` handshake
 * plus `"ok"` (or no probe at all — e.g. no `intendedAgentSlug` to probe)
 * both mean the agent is usable right now, so both map to `"connected"`.
 * `"sign_in_needed"` MUST read as `auth_required` (acceptance criterion 10:
 * "sign-in needed", never "failed"), and `"probe_failed"` is kept distinct
 * as a real `error` rather than folded into either of the other two. The
 * socket-close → `"disconnected"` transition is handled separately, by
 * `markAgentsDisconnected` above — this function only ever runs while the
 * connection is live.
 */
function mapAuthStateToAgentStatus(authState: BridgeInitializeMeta["authState"]): AgentStatus {
  switch (authState) {
    case "sign_in_needed":
      return "auth_required";
    case "probe_failed":
      return "error";
    case "ok":
    case null:
      return "connected";
    default:
      return authState satisfies never;
  }
}
