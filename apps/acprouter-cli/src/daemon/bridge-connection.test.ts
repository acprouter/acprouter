import { describe, expect, it, vi } from "vitest";
import { computeReconnectDelay, nextBackoffMs } from "./bridge-connection";

const wsConstructorCalls = vi.hoisted(() => [] as Array<{ url: string; options: unknown }>);

vi.mock("ws", async () => {
  const { EventEmitter } = await import("node:events");
  class FakeWebSocket extends EventEmitter {
    constructor(url: string, options?: unknown) {
      super();
      wsConstructorCalls.push({ url, options });
    }
    close() {
      this.emit("close", 1000, Buffer.from(""));
    }
  }
  return { WebSocket: FakeWebSocket };
});

describe("computeReconnectDelay", () => {
  it("stays within ±20% jitter of the cold-start backoff value", () => {
    for (let i = 0; i < 200; i++) {
      const delay = computeReconnectDelay(false, 4000);
      expect(delay).toBeGreaterThanOrEqual(Math.round(4000 * 0.8));
      expect(delay).toBeLessThanOrEqual(Math.round(4000 * 1.2));
    }
  });

  it("stays within ±20% jitter of the fast-reconnect floor when the connection had opened", () => {
    for (let i = 0; i < 200; i++) {
      const delay = computeReconnectDelay(true, 30_000);
      // Base is FAST_RECONNECT_MS (500), not the cold-start backoffMs passed in —
      // the whole point of `hadOpenConnection` is ignoring the backoff ladder.
      expect(delay).toBeGreaterThanOrEqual(Math.round(500 * 0.8));
      expect(delay).toBeLessThanOrEqual(Math.round(500 * 1.2));
    }
  });

  it("never returns less than the 500ms cold-start floor even at the smallest backoff", () => {
    for (let i = 0; i < 200; i++) {
      expect(computeReconnectDelay(false, 100)).toBeGreaterThanOrEqual(500);
    }
  });

  it("never returns less than the 250ms fast-reconnect floor", () => {
    for (let i = 0; i < 200; i++) {
      expect(computeReconnectDelay(true, 1000)).toBeGreaterThanOrEqual(250);
    }
  });

  it("produces varying delays across calls — proves jitter is actually applied, not a no-op", () => {
    const delays = new Set(Array.from({ length: 50 }, () => computeReconnectDelay(false, 8000)));
    expect(delays.size).toBeGreaterThan(1);
  });
});

describe("nextBackoffMs", () => {
  it("doubles on a cold-start failure, capped at 30s", () => {
    expect(nextBackoffMs(false, 1000)).toBe(2000);
    expect(nextBackoffMs(false, 16_000)).toBe(30_000);
    expect(nextBackoffMs(false, 30_000)).toBe(30_000);
  });

  it("resets to the 1s initial backoff after a connection that had genuinely opened", () => {
    expect(nextBackoffMs(true, 30_000)).toBe(1000);
    expect(nextBackoffMs(true, 1000)).toBe(1000);
  });
});

describe("startBridgeConnection — task #6.4 credential-as-header, never in the URL", () => {
  it("sends the bridge credential as an Authorization header, with no credential in the URL", async () => {
    wsConstructorCalls.length = 0;
    const { startBridgeConnection } = await import("./bridge-connection");

    const handle = startBridgeConnection(
      {
        server: "https://router.example.test",
        machineId: "machine_123",
        dir: "/work",
        intendedAgentSlug: null,
        bridgeCredential: "raw-bridge-secret",
      },
      () => {},
    );

    expect(wsConstructorCalls).toHaveLength(1);
    const [call] = wsConstructorCalls;
    expect(call.url).not.toContain("raw-bridge-secret");
    expect(call.options).toEqual({ headers: { Authorization: "Bearer raw-bridge-secret" } });

    await handle.stop();
  });

  it("opens no Authorization header at all for a legacy machine with no bridge credential", async () => {
    wsConstructorCalls.length = 0;
    const { startBridgeConnection } = await import("./bridge-connection");

    const handle = startBridgeConnection(
      {
        server: "https://router.example.test",
        machineId: "machine_legacy",
        dir: "/work",
        intendedAgentSlug: null,
      },
      () => {},
    );

    expect(wsConstructorCalls).toHaveLength(1);
    expect(wsConstructorCalls[0].options).toBeUndefined();

    await handle.stop();
  });
});
