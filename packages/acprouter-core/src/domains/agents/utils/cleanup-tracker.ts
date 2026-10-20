/**
 * Parent-owned (`AgentsPageClientBody`) tracker for best-effort `sessions.end`
 * disposal outcomes that originate from the bridged-enrollment flow but must
 * survive past the moment the component that triggered them unmounts.
 *
 * Final review follow-up: `agent-enrollment-flow.ts`'s own `lastCleanup`/
 * `retryCleanup` already tracks a disposal it fires itself (a late/superseded
 * `sessions.start` result) — but that state lives inside the
 * `EnrollmentFlow` instance `AddAgentDialog` owns, which is discarded the
 * instant the dialog unmounts (closing during `starting-session`, or
 * navigating away). Separately, `session-lease.ts`'s `dispose()` — the path
 * that fires when the PARENT (`AgentsPageClientBody`, via
 * `handoff-coordinator.ts`) abandons an already-accepted lease before the
 * sheet adopts it — had no tracked outcome at all: `add-agent-dialog.tsx`'s
 * `endSession` dep for the lease wrapped the call in a bare
 * `.catch(() => undefined)`, discarding both `ok:false` and a transport
 * rejection with no retry surface.
 *
 * Both gaps share one fix: a single disposal-outcome tracker owned by
 * `AgentsPageClientBody` itself (never by the dialog, never by the lease),
 * so a failure is visible and retryable for as long as the Agents page is
 * mounted — regardless of whether the dialog that originated the disposal
 * still exists. Mirrors `agent-enrollment-flow.ts`'s already-proven
 * `lastCleanup`/`disposeSession`/`retryCleanup` shape rather than inventing a
 * new one; the difference is purely in who holds the instance and for how
 * long.
 *
 * One entry per in-flight-or-settled disposal, keyed by `sessionId` — not a
 * single `lastCleanup` slot — because the flow's own late-disposal and the
 * lease's abandonment-disposal can be two independent sessions in flight at
 * once (e.g. a fresh attempt's late `sessions.start` result disposes session
 * A while a previous attempt's accepted-but-unadopted lease disposes session
 * B). Keying by `sessionId` also means a retry can never duplicate a pending
 * entry: re-dispatching for a session already `"pending"` is a no-op.
 */

export type CleanupStatus = "pending" | "ok" | "failed";

export interface CleanupEntry {
  agentId: string;
  sessionId: string;
  status: CleanupStatus;
}

export interface CleanupTracker {
  /** Current snapshot, ordered by first-tracked. */
  getEntries: () => readonly CleanupEntry[];
  subscribe: (listener: (entries: readonly CleanupEntry[]) => void) => () => void;
  /**
   * Starts (or re-fires) best-effort disposal for `{ agentId, sessionId }`
   * and resolves to the same `{ ok }` shape `sessions.end` itself returns —
   * so this can be used as a drop-in `endSession`-shaped dependency by any
   * caller (`agent-enrollment-flow.ts`'s `EnrollmentDeps.endSession`,
   * `session-lease.ts`'s `SessionLeaseDeps.endSession`) that needs the
   * outcome back directly, while the tracker ALSO records the attempt in
   * `getEntries()` so it is independently visible/retryable after that
   * caller is gone.
   *
   * No-op-and-reuse if an entry for this exact `sessionId` is already
   * `"pending"` — never issues a second concurrent `endSession` call for the
   * same session; the returned promise resolves once that existing pending
   * call settles.
   */
  dispose: (agentId: string, sessionId: string) => Promise<{ ok: boolean }>;
  /** Removes a settled (`"ok"`) entry from the visible list, e.g. once a retry banner's dismissal is acknowledged. No-op for `"pending"`. */
  dismiss: (sessionId: string) => void;
}

export interface CleanupTrackerDeps {
  /** Fire-and-forget-shaped from the caller's perspective, but its outcome IS awaited internally — must not throw synchronously. */
  endSession: (agentId: string, sessionId: string) => Promise<{ ok: boolean }>;
}

export function createCleanupTracker(deps: CleanupTrackerDeps): CleanupTracker {
  const entries = new Map<string, CleanupEntry>();
  // Tracks the in-flight promise for a `"pending"` sessionId so a duplicate
  // `dispose()` call while one is already running can hand back that SAME
  // promise instead of either firing a second concurrent `endSession` call
  // or returning a disconnected result the caller can't actually wait on.
  const inFlight = new Map<string, Promise<{ ok: boolean }>>();
  const listeners = new Set<(entries: readonly CleanupEntry[]) => void>();

  const emit = () => {
    const snapshot = Array.from(entries.values());
    for (const listener of listeners) listener(snapshot);
  };

  const dispose = (agentId: string, sessionId: string): Promise<{ ok: boolean }> => {
    const existing = entries.get(sessionId);
    if (existing?.status === "pending") {
      // Already in flight — never duplicate the network call; hand back the
      // same promise so this caller still learns the eventual outcome.
      return inFlight.get(sessionId) ?? Promise.resolve({ ok: false });
    }

    entries.set(sessionId, { agentId, sessionId, status: "pending" });
    emit();

    const promise = deps.endSession(agentId, sessionId).then(
      (result) => {
        // A dismiss() or a newer dispose() for this sessionId may have
        // already replaced/removed this entry by the time this settles.
        const current = entries.get(sessionId);
        if (current?.status === "pending") {
          entries.set(sessionId, { agentId, sessionId, status: result.ok ? "ok" : "failed" });
          emit();
        }
        return result;
      },
      () => {
        const current = entries.get(sessionId);
        if (current?.status === "pending") {
          entries.set(sessionId, { agentId, sessionId, status: "failed" });
          emit();
        }
        return { ok: false };
      },
    );
    inFlight.set(sessionId, promise);
    void promise.finally(() => {
      if (inFlight.get(sessionId) === promise) inFlight.delete(sessionId);
    });
    return promise;
  };

  const dismiss = (sessionId: string) => {
    const existing = entries.get(sessionId);
    if (!existing || existing.status === "pending") return;
    entries.delete(sessionId);
    emit();
  };

  return {
    getEntries: () => Array.from(entries.values()),
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    dispose,
    dismiss,
  };
}
