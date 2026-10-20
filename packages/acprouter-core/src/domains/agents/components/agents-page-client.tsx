"use client";

import type { AgentCatalogEntryVO, AgentVO, MachineVO } from "@acprouter/contract";
import { Button } from "kui/button";
import { useCallback, useEffect, useRef, useState } from "react";
import { AcprouterOrpcProvider, useAcprouterOrpc } from "../client";
import { type CleanupEntry, createCleanupTracker } from "../utils/cleanup-tracker";
import { createHandoffCoordinator } from "../utils/handoff-coordinator";
import type { SessionLease } from "../utils/session-lease";
import { AgentCatalogGrid } from "./agent-catalog-grid";
import { AgentSessionSheet } from "./agent-session-sheet";
import { MachinesList } from "./machines-list";
import { RegisteredAgentsList } from "./registered-agents-list";

const REFRESH_INTERVAL_MS = 5000;

interface AgentsPageClientProps {
  entries: AgentCatalogEntryVO[];
  /** Base URL the oRPC client sends requests to, e.g. `/api/rpc` — supplied by whichever app mounts this component, never hardcoded in this package. */
  apiBasePath: string;
  /** Forwarded to `AgentCatalogGrid`; defaults to `false` until the host provides the Buda OAuth routes. */
  budaOAuthEnabled?: boolean;
}

/**
 * Top-level composed page component. Owns the oRPC client for this whole
 * subtree via `AcprouterOrpcProvider` (base path supplied by the host app),
 * so every descendant — this component included, through `useAcprouterOrpc`
 * — shares ONE client instance instead of each file constructing its own.
 */
export function AgentsPageClient({
  entries,
  apiBasePath,
  budaOAuthEnabled,
}: AgentsPageClientProps) {
  return (
    <AcprouterOrpcProvider apiBasePath={apiBasePath}>
      <AgentsPageClientBody entries={entries} budaOAuthEnabled={budaOAuthEnabled} />
    </AcprouterOrpcProvider>
  );
}

/**
 * Owns ONE poll of both `agents.list` and `machines.list` (task #10) — both
 * `RegisteredAgentsList` and `MachinesList` used to poll independently
 * (`MachinesList` self-polled; there was no `agents.list` to poll at all
 * before this task), which would otherwise mean two intervals racing each
 * other for no reason once both exist. `AgentCatalogGrid`'s enrollment
 * dialog calls `refresh` on success instead of handing back a single
 * `MachineVO` — the parent needs BOTH lists to reflect a newly-connected
 * agent, not just the machine row.
 *
 * Also owns the bridged-enrollment handoff (design.md Decision 5): this is
 * the one place that both triggers `refresh()` (unchanged) and, when
 * `onConnected` reports a `{ agentId, sessionId }` payload plus a
 * `SessionLease`, closes the Add dialog itself (via the lifted
 * `bridgedDialogEntryId` seam) and, only once that close has actually
 * committed, opens `AgentSessionSheet` pre-adopting that already-live
 * session — never a second `sessions.start` call for the agent this flow
 * just added.
 *
 * Final Review Clarifications: "do not assume sequential React setters
 * avoid focus races" / "open/mount the keyed sheet only after dialog close
 * commit." The actual sequencing decision (when to mount the sheet, who
 * owns disposal at each point) is delegated to `createHandoffCoordinator`
 * (`utils/handoff-coordinator.ts`) — an isomorphic, unit-tested state
 * machine — so this component is thin glue between React events (dialog
 * close commit, sheet mount/unmount, port adoption) and that coordinator's
 * methods, not a second, untested copy of the same logic.
 */
function AgentsPageClientBody({
  entries,
  budaOAuthEnabled,
}: {
  entries: AgentCatalogEntryVO[];
  budaOAuthEnabled?: boolean;
}) {
  const orpc = useAcprouterOrpc();
  const [agents, setAgents] = useState<AgentVO[] | null>(null);
  const [machines, setMachines] = useState<MachineVO[] | null>(null);
  // The bridged Add dialog's open-ness, lifted out of `AgentCatalogGrid` so
  // this component can close it itself the instant a handoff payload
  // arrives, ahead of mounting the sheet below (design.md Decision 5's
  // close-then-open ordering, which is what keeps the dialog's own
  // close-autofocus from racing the sheet's open-focus).
  const [bridgedDialogEntryId, setBridgedDialogEntryId] = useState<string | null>(null);
  const [pendingHandoff, setPendingHandoff] = useState<{
    agentId: string;
    agentLabel: string;
    sessionId: string;
  } | null>(null);
  // One coordinator instance for this component's whole lifetime — its
  // internal state (awaiting-mount lease vs. mounted-awaiting-adoption
  // lease) persists across renders exactly like the refs it replaces.
  const coordinatorRef = useRef(createHandoffCoordinator());
  // Stable ref so the tracker's `endSession` dep (captured once, below) can
  // always reach the current oRPC client without the tracker instance
  // itself needing to be recreated when `orpc` changes identity.
  const orpcRef = useRef(orpc);
  orpcRef.current = orpc;
  // Parent-owned disposal-outcome tracker (`cleanup-tracker.ts`) — survives
  // `AddAgentDialog`/its `SessionLease` unmounting mid-disposal, so a failed
  // best-effort `sessions.end` call (transport rejection or `ok:false`)
  // remains visible and retryable for as long as this page is mounted,
  // closing the gap codex's final review flagged: before this, both the
  // flow's own late-disposal and the lease's abandonment-disposal lost their
  // failure state the instant the dialog that triggered them unmounted.
  const cleanupTrackerRef = useRef(
    createCleanupTracker({
      endSession: (agentId, sessionId) =>
        orpcRef.current.agents.sessions.end({ agentId, sessionId }),
    }),
  );
  const [cleanupEntries, setCleanupEntries] = useState<readonly CleanupEntry[]>([]);
  useEffect(() => cleanupTrackerRef.current.subscribe(setCleanupEntries), []);
  const handleCleanupDispatch = useCallback(
    (agentId: string, sessionId: string) => cleanupTrackerRef.current.dispose(agentId, sessionId),
    [],
  );
  const handleRetryCleanup = useCallback((entry: CleanupEntry) => {
    void cleanupTrackerRef.current.dispose(entry.agentId, entry.sessionId);
  }, []);

  const refresh = useCallback(() => {
    orpc.agents.agents
      .list()
      .then(setAgents)
      .catch(() => undefined);
    orpc.agents.machines
      .list()
      .then(setMachines)
      .catch(() => undefined);
  }, [orpc]);

  useEffect(() => {
    refresh();
    const interval = setInterval(refresh, REFRESH_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [refresh]);

  const handleCatalogConnected = useCallback(
    (result?: { agentId: string; sessionId: string }, lease?: SessionLease) => {
      refresh();
      if (!result || !lease) return;
      const label = entries.find((entry) => entry.id === bridgedDialogEntryId)?.name ?? "Agent";
      // Takes synchronous custody of the lease via the coordinator BEFORE
      // triggering the close — deliberately does NOT also call
      // `setPendingHandoff` here; that would commit both in the same
      // render, exactly the "simultaneous setters" shape Final Review
      // Clarifications warns against trusting to sequence focus correctly.
      coordinatorRef.current.onConnected(result, label, lease);
      setBridgedDialogEntryId(null);
    },
    [refresh, entries, bridgedDialogEntryId],
  );

  // The close-commit barrier: only runs once `bridgedDialogEntryId` has
  // actually become `null` — i.e. strictly after the dialog's own close has
  // committed as its own render, never bundled into the same commit as the
  // close. `onDialogClosed` is a no-op if there is no lease waiting.
  useEffect(() => {
    if (bridgedDialogEntryId !== null) return;
    coordinatorRef.current.onDialogClosed();
    setPendingHandoff(coordinatorRef.current.getPendingHandoff());
  }, [bridgedDialogEntryId]);

  // If this component unmounts (page navigated away) at any point before a
  // lease has been adopted — whether still awaiting the close-commit
  // barrier above, or already mounted but not yet adopted by the sheet's
  // own port — the lease must not leak. `onSurfaceGoneBeforeAdoption` is
  // itself idempotent-safe (delegates to `lease.dispose()`, a no-op once
  // already `adopted`/`disposed`).
  useEffect(() => () => coordinatorRef.current.onSurfaceGoneBeforeAdoption(), []);

  // Fires the instant the sheet's own session port actually starts
  // consuming the adopted session (see `agent-session-port.ts`'s
  // `onAdopted` call inside `start()`) — the real "the sheet adopted it"
  // signal, as opposed to merely having been asked to render.
  const handleSheetAdopted = useCallback((_agentId: string, sessionId: string) => {
    coordinatorRef.current.onSheetAdopted(sessionId);
  }, []);

  return (
    <div className="flex flex-col gap-6">
      {/* Visible for as long as this page is mounted, independent of
          whether the dialog that originated the disposal still exists —
          the gap codex's final review flagged (`add-agent-dialog.tsx:148`
          discarded `ok:false`/rejections with no retry surface once the
          dialog unmounted). One line per failed entry; `"pending"`/`"ok"`
          entries render nothing here. */}
      {cleanupEntries
        .filter((entry) => entry.status === "failed")
        .map((entry) => (
          <p key={entry.sessionId} className="text-sm text-destructive" role="status">
            Could not confirm an earlier session was cleaned up.{" "}
            <Button
              variant="link"
              className="h-auto p-0 text-destructive"
              onClick={() => handleRetryCleanup(entry)}
            >
              Retry cleanup
            </Button>
          </p>
        ))}
      <RegisteredAgentsList agents={agents} machines={machines} onRemoved={refresh} />
      <AgentCatalogGrid
        entries={entries}
        onConnected={handleCatalogConnected}
        budaOAuthEnabled={budaOAuthEnabled}
        bridgedDialogEntryId={bridgedDialogEntryId}
        onBridgedDialogEntryIdChange={setBridgedDialogEntryId}
        onCleanupDispatch={handleCleanupDispatch}
      />
      <MachinesList machines={machines} />
      {pendingHandoff && (
        <AgentSessionSheet
          key={pendingHandoff.sessionId}
          agentId={pendingHandoff.agentId}
          agentLabel={pendingHandoff.agentLabel}
          adoptedSessionId={pendingHandoff.sessionId}
          open={true}
          onOpenChange={(open) => {
            if (!open) {
              // The sheet is closing — if its port never got to call
              // `onAdopted` (an edge case: closed instantly, before the
              // port's `start()` promise microtask ran), the lease would
              // otherwise be dropped on the floor by `setPendingHandoff`
              // unmounting it with nothing left watching. Idempotent no-op
              // if `handleSheetAdopted` already claimed it.
              coordinatorRef.current.onSurfaceGoneBeforeAdoption();
              setPendingHandoff(null);
            }
          }}
          onAdopted={handleSheetAdopted}
        />
      )}
    </div>
  );
}
