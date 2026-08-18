import * as acp from "@agentclientprotocol/sdk";
import { createWebSocketStream } from "@agentclientprotocol/sdk/experimental/ws-client";
import { WebSocket } from "ws";

/**
 * The consumer-side shim's whole job (spec §5.3 point 2 / §5.4): an ACP
 * AGENT on stdio (what Zed/JetBrains spawn and talk to), an ACP CLIENT
 * dialled out over WebSocket to the Router's consumer endpoint (task #14).
 * Architecturally closest to `apps/acprouter-cli/src/daemon/bridge-agent.ts`
 * — agent role on one transport, client role on another, forwarding between
 * them, capturing the outer `ctx.client` at first-request time to relay
 * incoming notifications/requests back — but simpler: there is no spawning
 * (nothing is launched here, only protocol relayed), no registry-only
 * invariant to enforce, and no local filesystem/cwd concern. Every handler
 * below is a 1:1 forward, not a translation, unlike
 * `consumer-acp-connection.ts` (the Router's OWN agent-role handlers, which
 * translate onto `sessions-logic.ts` because the Router has real session
 * state to manage) — this shim has none of its own; the Router already does
 * all of that.
 */

export interface CreateAcpShimAppDeps {
  /** `wss://<router>/api/acp?agentId=<id>` — built by `ws-url.ts`. */
  wsUrl: string;
  /** The consumer API key minted for this agent (task #14), sent as `Authorization: Bearer <apiKey>`. */
  apiKey: string;
  log?: (line: string) => void;
  /** Overridable ONLY for tests — production always dials with the real `ws` WebSocket constructor. */
  webSocketCtor?: typeof WebSocket;
  /** Overridable ONLY for tests — bounds how long `initialize` waits for the Router before failing loudly. */
  initializeTimeoutMs?: number;
}

export interface AcpShimHandle {
  app: acp.AgentApp;
  /** Closes the outbound Router connection — called on stdio-side shutdown. */
  close(): void;
}

const DEFAULT_INITIALIZE_TIMEOUT_MS = 15_000;

/**
 * Converts whatever the outbound Router connection threw into a real
 * JSON-RPC error the stdio-side agent handler can throw back at Zed — never
 * an uncaught exception, never a silent hang (this task's own point 4:
 * "must fail with a clear, real error"). A `RequestError` the Router itself
 * raised (e.g. a rejected credential surfaced at `initialize`, per
 * `consumer-acp-connection.ts`) is passed through unchanged so its real
 * JSON-RPC code/message reaches Zed; anything else (a dial failure, the
 * timeout below, a closed connection) becomes `internalError` with a
 * message naming which ACP call failed and why.
 */
function toShimRequestError(error: unknown, label: string): acp.RequestError {
  if (error instanceof acp.RequestError) return error;
  const message = error instanceof Error ? error.message : String(error);
  return acp.RequestError.internalError({ label }, `acprouter-acp: ${label} failed: ${message}`);
}

/**
 * Builds the shim's stdio-side `AgentApp`. Dials the Router's consumer
 * WebSocket endpoint ONCE, eagerly, for the whole call's lifetime — not
 * lazily per request, not reconnected on drop. Spec's own steer for this
 * task: Zed spawns a fresh shim process per configured agent already, so
 * the shim's own process lifetime already bounds the connection's lifetime
 * (unlike the CLI daemon's job of staying up indefinitely across sleep/
 * wake/Router restarts, which is why `bridge-connection.ts` earns its
 * reconnect-with-backoff machinery and this file deliberately does not
 * copy it) — and one WebSocket already carries many `session/new`s via
 * `sessionId`, so there is nothing to multiplex here beyond forwarding.
 */
export function createAcpShimApp(deps: CreateAcpShimAppDeps): AcpShimHandle {
  const log = deps.log ?? (() => {});
  const webSocketCtor = deps.webSocketCtor ?? WebSocket;
  const initializeTimeoutMs = deps.initializeTimeoutMs ?? DEFAULT_INITIALIZE_TIMEOUT_MS;

  // Captured on the stdio side's first request — this shim serves exactly
  // one stdio connection for its whole process lifetime (Zed connects once),
  // so one captured reference is all any later Router-originated
  // notification/request ever needs to relay through. Same shape
  // `bridge-agent.ts` uses for its own `outerClient`, just without a
  // per-session map: there is only ever one "outer" here, not one per
  // spawned child.
  let outerClient: acp.AgentContext | null = null;

  const routerClientApp = acp
    .client({ name: "acprouter-acp" })
    .onNotification(acp.methods.client.session.update, (ctx) => {
      if (!outerClient) {
        log("dropped a session/update from the Router: no stdio client attached yet");
        return;
      }
      void outerClient.notify(acp.methods.client.session.update, ctx.params).catch((error) => {
        log(`failed to relay session/update to the stdio client: ${String(error)}`);
      });
    })
    .onRequest(acp.methods.client.session.requestPermission, async (ctx) => {
      if (!outerClient) {
        throw acp.RequestError.internalError(
          {},
          "acprouter-acp: no stdio client attached to relay this permission request to",
        );
      }
      return outerClient.request(acp.methods.client.session.requestPermission, ctx.params);
    });

  const stream = createWebSocketStream(deps.wsUrl, {
    headers: { Authorization: `Bearer ${deps.apiKey}` },
    WebSocket: webSocketCtor,
  });
  const routerConnection = routerClientApp.connect(stream);
  routerConnection.closed.catch((error) => {
    log(`Router connection closed: ${error instanceof Error ? error.message : String(error)}`);
  });

  const app = acp
    .agent({ name: "acprouter-acp" })
    .onRequest(acp.methods.agent.initialize, async (ctx) => {
      outerClient = ctx.client;
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const timedOut = new Promise<never>((_, reject) => {
          timer = setTimeout(
            () =>
              reject(
                new Error(
                  `could not reach the Router within ${initializeTimeoutMs}ms — check --server/` +
                    "ACPROUTER_SERVER, the API key, and that the Router is reachable",
                ),
              ),
            initializeTimeoutMs,
          );
        });
        return await Promise.race([
          routerConnection.agent.request(acp.methods.agent.initialize, ctx.params),
          timedOut,
        ]);
      } catch (error) {
        throw toShimRequestError(error, "initialize");
      } finally {
        clearTimeout(timer);
      }
    })
    .onRequest(acp.methods.agent.session.new, async (ctx) => {
      outerClient = ctx.client;
      try {
        return await routerConnection.agent.request(acp.methods.agent.session.new, ctx.params);
      } catch (error) {
        throw toShimRequestError(error, "session/new");
      }
    })
    .onRequest(acp.methods.agent.session.prompt, async (ctx) => {
      // Deliberately no timeout here (unlike `initialize` above): by the
      // time a `session/prompt` arrives, `initialize` already proved the
      // Router is reachable, and a real prompt can legitimately run for
      // minutes. The SDK's own connection layer already rejects any
      // in-flight request the moment the underlying stream closes (it
      // never just hangs), so there is nothing this handler needs to add.
      try {
        return await routerConnection.agent.request(acp.methods.agent.session.prompt, ctx.params);
      } catch (error) {
        throw toShimRequestError(error, "session/prompt");
      }
    })
    .onNotification(acp.methods.agent.session.cancel, async (ctx) => {
      try {
        await routerConnection.agent.notify(acp.methods.agent.session.cancel, ctx.params);
      } catch (error) {
        log(`failed to relay session/cancel to the Router: ${String(error)}`);
      }
    });

  return {
    app,
    close() {
      routerConnection.close(new Error("acprouter-acp shim shutting down"));
    },
  };
}
