/**
 * Pure, isomorphic ownership tracker for a `sessions.start` result crossing
 * from `AddAgentDialog`'s coordinator to the parent (`AgentsPageClientBody`)
 * to the sheet's own session port (`createAgentSessionPort`).
 *
 * Final Review Clarifications: "transfer {agentId,agentLabel,sessionId} only
 * after parent acknowledges adoption. Before acknowledgment the attempt owns
 * cleanup; after acknowledgment sheet owns it." A lease models exactly these
 * three parties and two handoffs as explicit, idempotent transitions instead
 * of inferring ownership from "did a callback get called" (which `ack()`
 * alone could not prove the sheet ever mounted):
 *
 *   prepared --accept()--> accepted --adopt()--> adopted   (terminal, no disposal)
 *      |                      |
 *      dispose()           dispose()
 *      v                      v
 *   disposed (terminal)   disposed (terminal)
 *
 * - `prepared`: the dialog has a resolved `{ agentId, sessionId }` and has
 *   called `onConnected`, but the parent has not yet committed to it.
 * - `accepted`: the parent has committed to mounting a session surface for
 *   this id (set its own pending-handoff state) — ownership of disposal-on-
 *   abandonment moves to the parent, but the sheet has not yet actually
 *   started consuming the session.
 * - `adopted`: the sheet's own `AcpSessionPort.start()` actually ran and
 *   resolved with this `sessionId` — from this point on, `@acp-ui/core`'s
 *   own unmount cleanup (`port.end?.(sessionId)`) is the disposal path; this
 *   lease has nothing further to do.
 * - `disposed`: `dispose()` won by racing a terminal transition — fires the
 *   caller-supplied best-effort end exactly once, from whichever state the
 *   lease was in when it was called (never after `adopted`).
 *
 * Idempotence: every method after the first terminal transition is a no-op.
 * This is what makes "unmount before adoption" and "StrictMode re-invoke"
 * both safe to call blindly from cleanup — the lease itself decides whether
 * there is anything left to do.
 */

export type SessionLeaseState = "prepared" | "accepted" | "adopted" | "disposed";

export interface SessionLease {
  readonly agentId: string;
  readonly sessionId: string;
  getState: () => SessionLeaseState;
  /** Parent has committed to mounting a surface for this session. No-op once accepted/adopted/disposed. */
  accept: () => void;
  /** The sheet's session port actually started consuming this session. No-op unless currently `accepted`. */
  adopt: () => void;
  /**
   * Fires the best-effort disposal exactly once, only if the lease is not
   * already `adopted` (nothing to dispose of once the sheet owns it) or
   * already `disposed` (idempotent — a second caller, e.g. both the dialog's
   * deferred-microtask cleanup AND a direct unmount, must not double-end the
   * same session). Returns whether this call was the one that actually
   * disposed (useful for tests/telemetry, not required for correctness).
   */
  dispose: () => boolean;
}

export interface SessionLeaseDeps {
  /** Fire-and-forget best-effort session end — must not throw synchronously. */
  endSession: (agentId: string, sessionId: string) => void;
}

export function createSessionLease(
  agentId: string,
  sessionId: string,
  deps: SessionLeaseDeps,
): SessionLease {
  let state: SessionLeaseState = "prepared";

  return {
    agentId,
    sessionId,
    getState: () => state,

    accept: () => {
      if (state === "prepared") state = "accepted";
    },

    adopt: () => {
      if (state === "accepted") state = "adopted";
    },

    dispose: () => {
      if (state === "adopted" || state === "disposed") return false;
      state = "disposed";
      deps.endSession(agentId, sessionId);
      return true;
    },
  };
}
