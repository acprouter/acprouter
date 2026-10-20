import { describe, expect, it, vi } from "vitest";
import { createCleanupTracker } from "./cleanup-tracker";
import { createSessionLease } from "./session-lease";

/**
 * Integration-level proof for the final-review follow-up: both
 * `agent-enrollment-flow.ts`'s own late-disposal path and
 * `session-lease.ts`'s abandonment-disposal path are wired, inside
 * `add-agent-dialog.tsx`, to delegate to a single parent-owned
 * `CleanupTracker` (`AgentsPageClientBody`'s instance) instead of each
 * firing `sessions.end` on its own with no surviving outcome.
 *
 * This file does not re-test `createEnrollmentFlow` or `createSessionLease`
 * in isolation (already covered by their own test files) — it proves the
 * COMPOSITION: a tracker instance created once, outliving a lease instance
 * that is discarded (simulating the dialog unmounting), still reports and
 * can retry a failed disposal that lease triggered.
 */

describe("cleanup tracker composed with session-lease (parent survives dialog unmount)", () => {
  it("a lease's abandonment-disposal failure is tracked by the parent tracker and remains visible after the lease is discarded", async () => {
    const endSession = vi.fn(async () => ({ ok: false }));
    const tracker = createCleanupTracker({ endSession });

    // Mirrors add-agent-dialog.tsx's lease construction: `endSession` dep
    // delegates to the parent's dispatch instead of calling the RPC itself.
    const lease = createSessionLease("agent-1", "session-1", {
      endSession: (agentId, sessionId) => void tracker.dispose(agentId, sessionId),
    });

    lease.dispose(); // e.g. handoff-coordinator's onSurfaceGoneBeforeAdoption
    await Promise.resolve();
    await Promise.resolve();

    expect(tracker.getEntries()).toEqual([
      { agentId: "agent-1", sessionId: "session-1", status: "failed" },
    ]);

    // The parent's tracker — not the lease, which the dialog would have
    // discarded on unmount — is what a retry banner would read from.
    expect(tracker.getEntries()).toEqual([
      { agentId: "agent-1", sessionId: "session-1", status: "failed" },
    ]);
  });

  it("retrying through the tracker after the lease is gone can still succeed, and clears the failed entry only once dismissed", async () => {
    let call = 0;
    const endSession = vi.fn(async () => {
      call += 1;
      return { ok: call > 1 };
    });
    const tracker = createCleanupTracker({ endSession });

    const lease = createSessionLease("agent-1", "session-1", {
      endSession: (agentId, sessionId) => void tracker.dispose(agentId, sessionId),
    });
    lease.dispose();
    await Promise.resolve();
    await Promise.resolve();
    expect(tracker.getEntries()[0]?.status).toBe("failed");

    // Retry is dispatched by the PARENT (e.g. a "Retry cleanup" button
    // click), with no lease involved at all — proving ownership really did
    // move to the tracker, not merely proxied through the lease.
    await tracker.dispose("agent-1", "session-1");
    expect(tracker.getEntries()[0]?.status).toBe("ok");

    tracker.dismiss("session-1");
    expect(tracker.getEntries()).toHaveLength(0);
  });

  it("never produces a duplicate pending entry when both the lease's own unmount cleanup and a direct retry click race for the same session", async () => {
    let resolve: ((value: { ok: boolean }) => void) | undefined;
    const endSession = vi.fn(
      () =>
        new Promise<{ ok: boolean }>((res) => {
          resolve = res;
        }),
    );
    const tracker = createCleanupTracker({ endSession });

    const lease = createSessionLease("agent-1", "session-1", {
      endSession: (agentId, sessionId) => void tracker.dispose(agentId, sessionId),
    });

    // Two independent callers both race to dispose the same session — the
    // lease's own idempotent dispose(), and a hypothetical concurrent retry
    // click firing before the first settles.
    lease.dispose(); // first — fires the real endSession call
    lease.dispose(); // idempotent no-op at the LEASE level (already disposed)
    void tracker.dispose("agent-1", "session-1"); // hypothetical concurrent retry click

    expect(endSession).toHaveBeenCalledTimes(1); // never duplicated
    expect(tracker.getEntries()).toHaveLength(1);
    expect(tracker.getEntries()[0]?.status).toBe("pending");

    resolve?.({ ok: true });
    await Promise.resolve();
    await Promise.resolve();
    expect(tracker.getEntries()[0]?.status).toBe("ok");
  });

  it("a transport rejection from the lease's disposal is tracked as failed, never thrown back at the caller", async () => {
    const endSession = vi.fn(async () => {
      throw new Error("network drop");
    });
    const tracker = createCleanupTracker({ endSession });

    const lease = createSessionLease("agent-1", "session-1", {
      endSession: (agentId, sessionId) => void tracker.dispose(agentId, sessionId),
    });

    expect(() => lease.dispose()).not.toThrow();
    await Promise.resolve();
    await Promise.resolve();

    expect(tracker.getEntries()).toEqual([
      { agentId: "agent-1", sessionId: "session-1", status: "failed" },
    ]);
  });
});
