/**
 * WebSocket keepalive (task #11, spec §5.5a) — chrome-acp's reference shape,
 * named explicitly in the spec: 30s ping/pong plus an `isAlive` flag per
 * connection. This is acceptance criterion 4's answer to "a WebSocket that's
 * quiet between tool calls is the classic thing a proxy/load-balancer idle
 * timeout kills" — a prompt that runs for minutes with only occasional
 * `session/update` traffic needs SOMETHING crossing the wire every 30s so no
 * ingress in front of either the Router or the CLI's outbound connection
 * ever sees it as idle.
 *
 * `ws` (the library both `machine-bridge-connection.ts` and
 * `apps/acprouter-cli/src/daemon/bridge-connection.ts` use) answers an
 * incoming `ping` frame with a `pong` automatically, at the protocol level,
 * with no application code required on the receiving side — confirmed
 * against `ws`'s own `Receiver`/`Sender` implementation, not assumed. That's
 * why this module only ever needs to be wired on the side that's deciding
 * whether the OTHER side is still alive; calling it from BOTH
 * `machine-bridge-connection.ts` (Router pinging the CLI) and
 * `bridge-connection.ts` (CLI pinging the Router) makes detection mutual —
 * either side notices a dead peer and can act (Router marks the machine
 * offline; the CLI's own reconnect-with-backoff loop fires sooner than
 * waiting out a TCP-level timeout).
 */

export const WS_KEEPALIVE_INTERVAL_MS = 30_000;

/** The minimal shape this needs from a `ws` WebSocket — a real one satisfies it structurally, no adapter required. */
export interface KeepaliveWebSocketLike {
  ping(): void;
  terminate(): void;
  on(type: "pong", listener: () => void): unknown;
}

/**
 * Starts the ping loop and returns a stop function. Call the stop function
 * once the connection closes for any other reason, or the interval leaks
 * for the life of the process.
 */
export function startWebSocketKeepalive(
  socket: KeepaliveWebSocketLike,
  intervalMs: number = WS_KEEPALIVE_INTERVAL_MS,
): () => void {
  let isAlive = true;
  const onPong = () => {
    isAlive = true;
  };
  socket.on("pong", onPong);

  const interval = setInterval(() => {
    if (!isAlive) {
      // The previous ping's pong never arrived — same "dead, not just quiet"
      // call chrome-acp makes. `terminate()` (not `close()`): the socket is
      // presumed unresponsive, so there is no point attempting a graceful
      // close handshake that will itself never complete.
      socket.terminate();
      return;
    }
    isAlive = false;
    socket.ping();
  }, intervalMs);

  return () => clearInterval(interval);
}
