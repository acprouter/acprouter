import { afterEach, describe, expect, it } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import { startWebSocketKeepalive } from "./ws-keepalive";

/**
 * Task #11, acceptance criterion 4 / spec §5.5a — the 30s ping/pong loop
 * that keeps a quiet-between-tool-calls socket from reading as idle to a
 * proxy/load balancer in front of it. Two tiers, deliberately: the "stays
 * alive" case uses a REAL `ws` client/server pair (the `ws` library answers
 * an incoming ping frame with a pong automatically, at the protocol level —
 * this test proves that real behavior actually keeps `isAlive` true across
 * several real cycles, not just that the code compiles). The "dead
 * connection gets terminated" case uses a controlled fake socket instead of
 * a real one that's failed to respond, because making a real `ws` client
 * NOT answer a ping (it auto-pongs unless the whole process is frozen) isn't
 * something a deterministic test can do without real flakiness — the
 * `isAlive`-flip-then-check logic being tested is transport-agnostic either
 * way.
 */
describe("startWebSocketKeepalive", () => {
  let wss: WebSocketServer | undefined;
  const stops: Array<() => void> = [];

  afterEach(() => {
    for (const stop of stops.splice(0)) stop();
    wss?.close();
    wss = undefined;
  });

  it("a real, responsive ws connection survives several real ping/pong cycles", async () => {
    wss = new WebSocketServer({ port: 0 });
    const port = (wss.address() as { port: number }).port;

    const serverSocketPromise = new Promise<WebSocket>((resolve) => {
      // biome-ignore lint/style/noNonNullAssertion: assigned synchronously above in this same test
      wss!.on("connection", (socket) => resolve(socket));
    });
    const client = new WebSocket(`ws://127.0.0.1:${port}`);
    await new Promise<void>((resolve, reject) => {
      client.once("open", () => resolve());
      client.once("error", reject);
    });
    const serverSocket = await serverSocketPromise;

    // 25ms interval — short enough to observe several real cycles quickly,
    // long enough that this isn't a busy-loop.
    const stop = startWebSocketKeepalive(serverSocket, 25);
    stops.push(stop);

    // Real `ws`-level pong events, not a stub — the SERVER side is the one
    // pinging here (mirrors `machine-bridge-connection.ts`'s role), so the
    // "pong" event fires on `serverSocket`: `ws` answers an incoming ping
    // automatically on the CLIENT side (no application code involved), and
    // that automatic pong is what the pinger receives back.
    let pongCount = 0;
    serverSocket.on("pong", () => {
      pongCount++;
    });
    await new Promise((resolve) => setTimeout(resolve, 200));

    expect(serverSocket.readyState).toBe(WebSocket.OPEN);
    expect(client.readyState).toBe(WebSocket.OPEN);
    // At 25ms/interval over 200ms, several pings should have gone out and
    // come back — a generous lower bound avoids CI timing flakiness while
    // still proving real frames crossed the wire more than once.
    expect(pongCount).toBeGreaterThanOrEqual(2);

    stop();
    client.close();
  });

  it("terminates a connection whose previous ping never got a pong back", async () => {
    let pinged = 0;
    let terminated = false;
    let pongListener: (() => void) | undefined;

    const fakeSocket = {
      ping: () => {
        pinged++;
      },
      terminate: () => {
        terminated = true;
      },
      on: (type: "pong", listener: () => void) => {
        if (type === "pong") pongListener = listener;
        return fakeSocket;
      },
    };
    void pongListener; // never invoked — this socket never answers

    const stop = startWebSocketKeepalive(fakeSocket, 20);
    stops.push(stop);

    // First tick: sends a ping, marks isAlive=false, awaiting a pong that
    // will never come. Second tick: isAlive is still false -> terminate().
    await new Promise((resolve) => setTimeout(resolve, 55));

    expect(pinged).toBeGreaterThanOrEqual(1);
    expect(terminated).toBe(true);
  });
});
