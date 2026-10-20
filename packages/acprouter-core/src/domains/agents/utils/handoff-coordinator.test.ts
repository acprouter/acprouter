import { describe, expect, it, vi } from "vitest";
import { createHandoffCoordinator } from "./handoff-coordinator";
import type { SessionLease, SessionLeaseState } from "./session-lease";

function createFakeLease(agentId: string, sessionId: string) {
  let state: SessionLeaseState = "prepared";
  const dispose = vi.fn(() => {
    if (state === "adopted" || state === "disposed") return false;
    state = "disposed";
    return true;
  });
  const accept = vi.fn(() => {
    if (state === "prepared") state = "accepted";
  });
  const adopt = vi.fn(() => {
    if (state === "accepted") state = "adopted";
  });
  const lease: SessionLease = {
    agentId,
    sessionId,
    getState: () => state,
    accept,
    adopt,
    dispose,
  };
  return { lease, accept, adopt, dispose };
}

describe("createHandoffCoordinator", () => {
  it("onConnected does not set pendingHandoff by itself (no simultaneous setters)", () => {
    const coordinator = createHandoffCoordinator();
    const { lease } = createFakeLease("agent-1", "session-1");

    coordinator.onConnected({ agentId: "agent-1", sessionId: "session-1" }, "Agent One", lease);

    expect(coordinator.getPendingHandoff()).toBeNull();
  });

  it("onDialogClosed is a no-op when there is no awaiting lease", () => {
    const coordinator = createHandoffCoordinator();

    expect(() => coordinator.onDialogClosed()).not.toThrow();
    expect(coordinator.getPendingHandoff()).toBeNull();
  });

  it("onDialogClosed accepts the lease and promotes it to pendingHandoff", () => {
    const coordinator = createHandoffCoordinator();
    const { lease, accept, dispose } = createFakeLease("agent-1", "session-1");

    coordinator.onConnected({ agentId: "agent-1", sessionId: "session-1" }, "Agent One", lease);
    coordinator.onDialogClosed();

    expect(accept).toHaveBeenCalledTimes(1);
    expect(dispose).not.toHaveBeenCalled();
    expect(coordinator.getPendingHandoff()).toEqual({
      agentId: "agent-1",
      agentLabel: "Agent One",
      sessionId: "session-1",
    });
  });

  it("a second onDialogClosed call without a new onConnected is a no-op", () => {
    const coordinator = createHandoffCoordinator();
    const { lease, accept } = createFakeLease("agent-1", "session-1");

    coordinator.onConnected({ agentId: "agent-1", sessionId: "session-1" }, "Agent One", lease);
    coordinator.onDialogClosed();
    coordinator.onDialogClosed();

    expect(accept).toHaveBeenCalledTimes(1);
    expect(coordinator.getPendingHandoff()).toEqual({
      agentId: "agent-1",
      agentLabel: "Agent One",
      sessionId: "session-1",
    });
  });

  it("onSheetAdopted with a matching sessionId adopts the mounted lease and clears it", () => {
    const coordinator = createHandoffCoordinator();
    const { lease, adopt, dispose } = createFakeLease("agent-1", "session-1");

    coordinator.onConnected({ agentId: "agent-1", sessionId: "session-1" }, "Agent One", lease);
    coordinator.onDialogClosed();
    coordinator.onSheetAdopted("session-1");

    expect(adopt).toHaveBeenCalledTimes(1);
    // Adoption is terminal — a later "surface gone" must not dispose it.
    coordinator.onSurfaceGoneBeforeAdoption();
    expect(dispose).not.toHaveBeenCalled();
  });

  it("onSheetAdopted with a non-matching sessionId is a no-op", () => {
    const coordinator = createHandoffCoordinator();
    const { lease, adopt } = createFakeLease("agent-1", "session-1");

    coordinator.onConnected({ agentId: "agent-1", sessionId: "session-1" }, "Agent One", lease);
    coordinator.onDialogClosed();
    coordinator.onSheetAdopted("some-other-session");

    expect(adopt).not.toHaveBeenCalled();
    // The pendingHandoff and mounted lease are untouched, so a later
    // onSurfaceGoneBeforeAdoption can still dispose the still-mounted lease.
    coordinator.onSurfaceGoneBeforeAdoption();
    expect(coordinator.getPendingHandoff()).toBeNull();
  });

  it("onSheetAdopted before onDialogClosed (no mounted lease yet) is a no-op", () => {
    const coordinator = createHandoffCoordinator();
    const { lease, adopt } = createFakeLease("agent-1", "session-1");

    coordinator.onConnected({ agentId: "agent-1", sessionId: "session-1" }, "Agent One", lease);
    coordinator.onSheetAdopted("session-1");

    expect(adopt).not.toHaveBeenCalled();
  });

  it("onSurfaceGoneBeforeAdoption disposes an awaiting (not yet mounted) lease and clears state", () => {
    const coordinator = createHandoffCoordinator();
    const { lease, dispose } = createFakeLease("agent-1", "session-1");

    coordinator.onConnected({ agentId: "agent-1", sessionId: "session-1" }, "Agent One", lease);
    coordinator.onSurfaceGoneBeforeAdoption();

    expect(dispose).toHaveBeenCalledTimes(1);
    expect(coordinator.getPendingHandoff()).toBeNull();

    // A later close-commit must not resurrect the disposed-and-cleared lease.
    coordinator.onDialogClosed();
    expect(coordinator.getPendingHandoff()).toBeNull();
  });

  it("onSurfaceGoneBeforeAdoption disposes a mounted (awaiting sheet adoption) lease and clears pendingHandoff", () => {
    const coordinator = createHandoffCoordinator();
    const { lease, dispose } = createFakeLease("agent-1", "session-1");

    coordinator.onConnected({ agentId: "agent-1", sessionId: "session-1" }, "Agent One", lease);
    coordinator.onDialogClosed();
    coordinator.onSurfaceGoneBeforeAdoption();

    expect(dispose).toHaveBeenCalledTimes(1);
    expect(coordinator.getPendingHandoff()).toBeNull();
  });

  it("onSurfaceGoneBeforeAdoption is idempotent-safe when called repeatedly with nothing pending", () => {
    const coordinator = createHandoffCoordinator();

    expect(() => {
      coordinator.onSurfaceGoneBeforeAdoption();
      coordinator.onSurfaceGoneBeforeAdoption();
    }).not.toThrow();
    expect(coordinator.getPendingHandoff()).toBeNull();
  });

  it("a fresh onConnected after a prior handoff fully completed starts a new independent cycle", () => {
    const coordinator = createHandoffCoordinator();
    const first = createFakeLease("agent-1", "session-1");
    const second = createFakeLease("agent-2", "session-2");

    coordinator.onConnected(
      { agentId: "agent-1", sessionId: "session-1" },
      "Agent One",
      first.lease,
    );
    coordinator.onDialogClosed();
    coordinator.onSheetAdopted("session-1");

    coordinator.onConnected(
      { agentId: "agent-2", sessionId: "session-2" },
      "Agent Two",
      second.lease,
    );
    coordinator.onDialogClosed();

    expect(second.accept).toHaveBeenCalledTimes(1);
    expect(coordinator.getPendingHandoff()).toEqual({
      agentId: "agent-2",
      agentLabel: "Agent Two",
      sessionId: "session-2",
    });
    // The first lease's own dispose must never be touched by the second cycle.
    expect(first.dispose).not.toHaveBeenCalled();
  });
});
