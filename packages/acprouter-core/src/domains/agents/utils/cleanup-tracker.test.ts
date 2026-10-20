import { describe, expect, it, vi } from "vitest";
import { createCleanupTracker } from "./cleanup-tracker";

describe("createCleanupTracker", () => {
  it("starts a disposal as pending, then settles to ok", async () => {
    const endSession = vi.fn(async () => ({ ok: true }));
    const tracker = createCleanupTracker({ endSession });

    tracker.dispose("agent-1", "session-1");
    expect(tracker.getEntries()).toEqual([
      { agentId: "agent-1", sessionId: "session-1", status: "pending" },
    ]);

    await Promise.resolve();
    await Promise.resolve();

    expect(tracker.getEntries()).toEqual([
      { agentId: "agent-1", sessionId: "session-1", status: "ok" },
    ]);
    expect(endSession).toHaveBeenCalledWith("agent-1", "session-1");
    expect(endSession).toHaveBeenCalledTimes(1);
  });

  it("tracks an ok:false response as a failed entry, never throwing", async () => {
    const endSession = vi.fn(async () => ({ ok: false }));
    const tracker = createCleanupTracker({ endSession });

    tracker.dispose("agent-1", "session-1");
    await Promise.resolve();
    await Promise.resolve();

    expect(tracker.getEntries()).toEqual([
      { agentId: "agent-1", sessionId: "session-1", status: "failed" },
    ]);
  });

  it("tracks a transport rejection as a failed entry, never throwing", async () => {
    const endSession = vi.fn(async () => {
      throw new Error("network drop");
    });
    const tracker = createCleanupTracker({ endSession });

    expect(() => tracker.dispose("agent-1", "session-1")).not.toThrow();
    await Promise.resolve();
    await Promise.resolve();

    expect(tracker.getEntries()).toEqual([
      { agentId: "agent-1", sessionId: "session-1", status: "failed" },
    ]);
  });

  it("retrying a failed entry re-fires endSession and can succeed", async () => {
    let call = 0;
    const endSession = vi.fn(async () => {
      call += 1;
      return { ok: call > 1 };
    });
    const tracker = createCleanupTracker({ endSession });

    tracker.dispose("agent-1", "session-1");
    await Promise.resolve();
    await Promise.resolve();
    expect(tracker.getEntries()[0]?.status).toBe("failed");

    tracker.dispose("agent-1", "session-1"); // retry
    expect(tracker.getEntries()[0]?.status).toBe("pending");
    await Promise.resolve();
    await Promise.resolve();

    expect(tracker.getEntries()[0]?.status).toBe("ok");
    expect(endSession).toHaveBeenCalledTimes(2);
  });

  it("dispose() resolves to the real endSession outcome, usable as a drop-in endSession-shaped dependency", async () => {
    const endSession = vi.fn(async () => ({ ok: true }));
    const tracker = createCleanupTracker({ endSession });

    const result = await tracker.dispose("agent-1", "session-1");
    expect(result).toEqual({ ok: true });
  });

  it("a duplicate dispose() call while pending resolves once the SAME in-flight call settles, without firing a second endSession call", async () => {
    let resolve: ((value: { ok: boolean }) => void) | undefined;
    const endSession = vi.fn(
      () =>
        new Promise<{ ok: boolean }>((res) => {
          resolve = res;
        }),
    );
    const tracker = createCleanupTracker({ endSession });

    const first = tracker.dispose("agent-1", "session-1");
    const second = tracker.dispose("agent-1", "session-1");
    resolve?.({ ok: true });

    expect(await first).toEqual({ ok: true });
    expect(await second).toEqual({ ok: true });
    expect(endSession).toHaveBeenCalledTimes(1);
  });

  it("never issues a second concurrent dispose for a sessionId already pending (no duplicate pending cleanup)", async () => {
    let resolve: ((value: { ok: boolean }) => void) | undefined;
    const endSession = vi.fn(
      () =>
        new Promise<{ ok: boolean }>((res) => {
          resolve = res;
        }),
    );
    const tracker = createCleanupTracker({ endSession });

    tracker.dispose("agent-1", "session-1");
    tracker.dispose("agent-1", "session-1"); // must no-op — already pending
    tracker.dispose("agent-1", "session-1");

    expect(endSession).toHaveBeenCalledTimes(1);
    expect(tracker.getEntries()).toHaveLength(1);

    resolve?.({ ok: true });
    await Promise.resolve();
    await Promise.resolve();
    expect(tracker.getEntries()[0]?.status).toBe("ok");
  });

  it("tracks two independent sessions concurrently without one clobbering the other", async () => {
    const endSession = vi.fn(async (_agentId: string, sessionId: string) => ({
      ok: sessionId === "session-1",
    }));
    const tracker = createCleanupTracker({ endSession });

    tracker.dispose("agent-1", "session-1");
    tracker.dispose("agent-2", "session-2");
    await Promise.resolve();
    await Promise.resolve();

    const bySession = new Map(tracker.getEntries().map((e) => [e.sessionId, e.status]));
    expect(bySession.get("session-1")).toBe("ok");
    expect(bySession.get("session-2")).toBe("failed");
  });

  it("dismiss removes a settled entry but is a no-op while pending", async () => {
    const endSession = vi.fn(async () => ({ ok: true }));
    const tracker = createCleanupTracker({ endSession });

    tracker.dispose("agent-1", "session-1");
    tracker.dismiss("session-1"); // still pending — no-op
    expect(tracker.getEntries()).toHaveLength(1);

    await Promise.resolve();
    await Promise.resolve();
    tracker.dismiss("session-1");
    expect(tracker.getEntries()).toHaveLength(0);
  });

  it("resolving one tracked session's disposal never disturbs another's independently-pending disposal", async () => {
    const resolvers = new Map<string, (value: { ok: boolean }) => void>();
    const endSession = vi.fn(
      (_agentId: string, sessionId: string) =>
        new Promise<{ ok: boolean }>((res) => {
          resolvers.set(sessionId, res);
        }),
    );
    const tracker = createCleanupTracker({ endSession });

    tracker.dispose("agent-1", "session-1");
    tracker.dispose("agent-2", "session-2");
    resolvers.get("session-1")?.({ ok: false });
    await Promise.resolve();
    await Promise.resolve();

    const bySession = new Map(tracker.getEntries().map((e) => [e.sessionId, e.status]));
    expect(bySession.get("session-1")).toBe("failed");
    expect(bySession.get("session-2")).toBe("pending");
  });

  it("subscribe notifies listeners on every transition and unsubscribe stops further notifications", async () => {
    const endSession = vi.fn(async () => ({ ok: true }));
    const tracker = createCleanupTracker({ endSession });
    const snapshots: string[] = [];
    const unsubscribe = tracker.subscribe((entries) => {
      snapshots.push(entries.map((e) => e.status).join(","));
    });

    tracker.dispose("agent-1", "session-1");
    await Promise.resolve();
    await Promise.resolve();

    expect(snapshots).toEqual(["pending", "ok"]);

    unsubscribe();
    tracker.dispose("agent-2", "session-2");
    await Promise.resolve();
    await Promise.resolve();
    expect(snapshots).toEqual(["pending", "ok"]); // no further notifications
  });
});
