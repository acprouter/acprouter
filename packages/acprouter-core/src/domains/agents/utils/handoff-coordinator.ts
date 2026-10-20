import type { SessionLease } from "./session-lease";

/**
 * Pure, isomorphic model of `AgentsPageClientBody`'s handoff sequencing
 * (design.md Decision 5, Final Review Clarifications) — extracted so the
 * "close commits before the lease is accepted and the sheet mounts" rule
 * can be driven deterministically in a plain `vitest` node environment,
 * mirroring why `agent-enrollment-flow.ts` exists as its own module instead
 * of being inlined in `AddAgentDialog`.
 *
 * This models three independent events the real component wires to React
 * state/effects:
 *   - `onConnected(result, lease)`  — the dialog's coordinator handed off
 *   - `onDialogClosed()`            — `bridgedDialogEntryId` became `null`
 *     (the close-commit barrier's gate; in the real component this is an
 *     effect keyed on that state actually having changed)
 *   - `onSheetAdopted(sessionId)`   — the sheet's own port called `onAdopted`
 *   - `onSheetClosed()` / `onUnmount()` — the surface watching the lease
 *     went away before adoption
 *
 * and produces the one visible decision the component needs: when (if
 * ever) to mount the handoff sheet, with which `{ agentId, agentLabel,
 * sessionId }`. It never calls `lease.accept()`/`adopt()`/`dispose()`
 * itself out of band — those side effects stay exactly where the design
 * requires them (close-commit time, port-start time, unmount time), driven
 * by calling this coordinator's own methods at those moments.
 */

export interface HandoffCoordinator {
  /** The dialog's coordinator produced a result; takes synchronous custody of the lease. */
  onConnected: (
    result: { agentId: string; sessionId: string },
    label: string,
    lease: SessionLease,
  ) => void;
  /** The dialog's close has actually committed (not merely requested). */
  onDialogClosed: () => void;
  /** The mounted sheet's own session port actually started consuming the session. */
  onSheetAdopted: (sessionId: string) => void;
  /** The mounted sheet closed (or the page unmounted) before adoption. */
  onSurfaceGoneBeforeAdoption: () => void;
  /** What should currently be rendered as the handoff sheet, if anything. */
  getPendingHandoff: () => { agentId: string; agentLabel: string; sessionId: string } | null;
}

export function createHandoffCoordinator(): HandoffCoordinator {
  // "accepted but not yet mounted" — set by onConnected, cleared (and
  // promoted to `mountedLease`) by onDialogClosed.
  let awaitingLease: SessionLease | null = null;
  let awaitingLabel = "Agent";
  // "mounted but not yet adopted" — set by onDialogClosed, cleared by
  // onSheetAdopted or onSurfaceGoneBeforeAdoption.
  let mountedLease: SessionLease | null = null;
  let pendingHandoff: { agentId: string; agentLabel: string; sessionId: string } | null = null;

  return {
    onConnected: (result, label, lease) => {
      awaitingLease = lease;
      awaitingLabel = label;
      // Deliberately does NOT touch `pendingHandoff` here — that is exactly
      // the "simultaneous setters" shape this coordinator exists to forbid.
      void result;
    },

    onDialogClosed: () => {
      if (!awaitingLease) return;
      const lease = awaitingLease;
      awaitingLease = null;
      lease.accept();
      mountedLease = lease;
      pendingHandoff = {
        agentId: lease.agentId,
        agentLabel: awaitingLabel,
        sessionId: lease.sessionId,
      };
    },

    onSheetAdopted: (sessionId) => {
      if (mountedLease?.sessionId !== sessionId) return;
      mountedLease.adopt();
      mountedLease = null;
    },

    onSurfaceGoneBeforeAdoption: () => {
      awaitingLease?.dispose();
      awaitingLease = null;
      mountedLease?.dispose();
      mountedLease = null;
      pendingHandoff = null;
    },

    getPendingHandoff: () => pendingHandoff,
  };
}
