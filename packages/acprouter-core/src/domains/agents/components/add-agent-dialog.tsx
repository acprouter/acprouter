"use client";

import type { AgentCatalogEntryVO } from "@acprouter/contract";
import { Button } from "kui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "kui/dialog";
import { useEffect, useRef, useState } from "react";
import { useAcprouterOrpc } from "../client";
import {
  createEnrollmentFlow,
  type EnrollmentFlow,
  type EnrollmentFlowState,
} from "../utils/agent-enrollment-flow";
import { createSessionLease, type SessionLease } from "../utils/session-lease";

interface AddAgentDialogProps {
  entry: AgentCatalogEntryVO;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /**
   * Fired once `sessions.start` has genuinely resolved (design.md Decision
   * 3/6) — the parent adopts this session instead of starting a second one.
   * This dialog never closes itself; the parent does close-then-open after
   * receiving this.
   *
   * Ownership is explicit (Final Review Clarifications) and modeled by a
   * `SessionLease` (`utils/session-lease.ts`), not a bare `ack()` callback:
   * this dialog creates the lease in `prepared` state and keeps calling
   * `lease.dispose()` from its own unmount cleanup for as long as the
   * parent has not called `lease.accept()`. `onConnected` resolving (i.e.
   * this call returning) is NOT proof a sheet mounted — only the parent
   * calling `accept()`, and later the sheet's own port calling `adopt()`,
   * are. The lease's own idempotence is what makes it safe for both this
   * dialog's unmount cleanup AND a later caller to call `dispose()` without
   * coordinating with each other.
   */
  onConnected: (result: { agentId: string; sessionId: string }, lease: SessionLease) => void;
  /**
   * Routes every best-effort `sessions.end` disposal this dialog would
   * otherwise fire itself — both the enrollment flow's own late/superseded-
   * result cleanup (`agent-enrollment-flow.ts`'s `disposeSession`) and the
   * `SessionLease`'s own `dispose()` — through a tracker the PARENT owns
   * (`AgentsPageClientBody`'s `createCleanupTracker` instance) instead of
   * this component's local state, while still resolving to the same
   * `{ ok }` shape `orpc.agents.sessions.end` itself returns so both callers
   * can keep working exactly as before.
   *
   * Why this is required, not an enhancement: this dialog's own
   * `EnrollmentFlow` instance (and the lease it created) are both discarded
   * the moment this component unmounts — closing mid-flow, or navigating
   * away. Before this prop existed, a disposal failure that settled after
   * that point had no surface left to retry from, even though the Agents
   * page itself (the parent) was still mounted and could have shown it. When
   * provided, this dialog no longer calls `orpc.agents.sessions.end` itself
   * for either path — it calls this instead, so the SAME outcome lands in
   * state that outlives the dialog, in addition to being returned here.
   */
  onCleanupDispatch?: (agentId: string, sessionId: string) => Promise<{ ok: boolean }>;
}

/**
 * The bridged-agent Add flow (spec §2b), driven by the isomorphic
 * `createEnrollmentFlow` coordinator (design.md Decisions 1-4, 7-8): mint a
 * single-use token, show the exact command to paste, then track the
 * three-stage readiness ladder (machine online → agent registered → session
 * started) until `sessions.start` genuinely resolves — never on a redeemed
 * machine row alone (Final Review Clarifications).
 */
export function AddAgentDialog({
  entry,
  open,
  onOpenChange,
  onConnected,
  onCleanupDispatch,
}: AddAgentDialogProps) {
  const orpc = useAcprouterOrpc();
  const [state, setState] = useState<EnrollmentFlowState>({
    phase: { phase: "minting" },
    generation: 0,
    canRetry: false,
    lastCleanup: null,
  });
  const [copied, setCopied] = useState(false);
  const flowRef = useRef<EnrollmentFlow | null>(null);
  // Stable ref to the latest `onConnected` (Final Review Clarifications:
  // "stable callback useRef updated each render rather than stale
  // suppression") — the mint/poll effect below reads through this instead
  // of capturing `onConnected` directly, so a changing callback identity
  // never requires either a stale closure or restarting the whole flow.
  const onConnectedRef = useRef(onConnected);
  onConnectedRef.current = onConnected;
  // Same stable-ref pattern as `onConnectedRef` above — read inside the
  // mint/poll effect's `endSession` deps so a changing `onCleanupDispatch`
  // identity never requires restarting the flow or recreating the lease.
  const onCleanupDispatchRef = useRef(onCleanupDispatch);
  onCleanupDispatchRef.current = onCleanupDispatch;
  // The lease for the CURRENT open lifetime's handoff, if `handed-off` has
  // fired — `null` until then. Replaces the earlier bare
  // `handoffAcknowledgedRef` boolean: a `SessionLease` tracks the full
  // prepared/accepted/adopted/disposed lifecycle (see `session-lease.ts`),
  // so this dialog's own unmount cleanup can call `lease.dispose()`
  // unconditionally and trust the lease itself to no-op once the parent (or
  // the sheet, later) has already taken ownership.
  const leaseRef = useRef<SessionLease | null>(null);
  // StrictMode (dev only) mounts this effect, cleans it up, and mounts it
  // again — synchronously, same tick — specifically to surface a
  // non-idempotent side effect like `flow.start()`, which fires a real
  // `machines.mint` network call. A plain "create + start in the effect,
  // tear down in cleanup" shape mints TWICE for one user-visible dialog-open
  // (confirmed in a real browser: browser-flow-results.json showed
  // `mints: 2`) — React runs this cleanup synchronously, in the SAME tick,
  // before the replay's own setup, so there is no way to tell from the
  // cleanup alone whether it is final or about to be immediately replayed.
  //
  // The fix defers the real teardown to a microtask (a "cancelable token"):
  // cleanup schedules disposal instead of running it inline, and the next
  // synchronous effect invocation — if it is StrictMode's same-key replay —
  // cancels that pending disposal and reuses the still-live `flow` instead of
  // creating a second one. A genuinely new open (entry changed, or the
  // dialog was actually closed and later reopened) is a different key, so
  // the deferred disposal for the OLD key is left to run and the new key
  // creates its own flow as before.
  const pendingDisposalRef = useRef<{ key: string; run: () => void; token: object } | null>(null);

  // The flow is only ever (re)created when the dialog opens or the entry
  // changes — `onConnectedRef` above is what lets `onConnected` change
  // freely without restarting enrollment.
  useEffect(() => {
    if (!open) return;
    const key = entry.id;

    if (pendingDisposalRef.current?.key === key) {
      // Same-key replay landed before the deferred disposal's microtask ran
      // — cancel it and keep using the flow `flowRef.current` already holds.
      pendingDisposalRef.current = null;
    } else {
      // A different key's disposal (if any) is left to run via its own
      // already-scheduled microtask — it independently no-ops once it sees
      // `flowRef.current` no longer points at its own `liveFlow`. Closing
      // that OLD flow here, immediately, still matters: it stops its timers
      // and in-flight calls right away instead of leaving them running until
      // the microtask queue drains.
      pendingDisposalRef.current = null;
      flowRef.current?.close();
      flowRef.current = null;
    }

    let flow = flowRef.current;
    if (!flow) {
      flow = createEnrollmentFlow({
        mint: (intendedAgentSlug) => orpc.agents.machines.mint({ intendedAgentSlug }),
        listMachines: () => orpc.agents.machines.list(),
        listAgents: () => orpc.agents.agents.list(),
        startSession: (agentId) => orpc.agents.sessions.start({ agentId }),
        // When the parent supplies a dispatch (`AgentsPageClientBody`'s
        // `createCleanupTracker`), route through it instead of calling the
        // RPC directly: the tracker makes the SAME call and returns the SAME
        // `{ ok }` outcome this flow's own `disposeSession`/`lastCleanup`
        // still needs, but additionally records it in state that survives
        // this dialog unmounting mid-disposal. Falls back to the direct call
        // so this component stays independently usable without a parent.
        endSession: (agentId, sessionId) =>
          onCleanupDispatchRef.current
            ? onCleanupDispatchRef.current(agentId, sessionId)
            : orpc.agents.sessions.end({ agentId, sessionId }),
        now: () => Date.now(),
        setTimeout: (cb, ms) => setTimeout(cb, ms),
        clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
      });
      flowRef.current = flow;
      setCopied(false);
      leaseRef.current = null;
      flow.start(key, key);
    }

    const unsubscribe = flow.subscribe((next) => {
      setState(next);
      if (next.phase.phase === "handed-off" && !leaseRef.current) {
        // Guards against calling `onConnected` twice for one `handed-off`
        // transition: `leaseRef.current` is non-null from here on for the
        // rest of this open lifetime.
        const lease = createSessionLease(next.phase.agentId, next.phase.sessionId, {
          // Same delegation as the flow's own `endSession` dep above: when a
          // parent dispatch exists, route through it instead of a bare
          // `orpc...catch(() => undefined)` that discarded both `ok:false`
          // and a transport rejection with no retry surface — the exact gap
          // this prop exists to close.
          endSession: (agentId, sessionId) => {
            if (onCleanupDispatchRef.current) {
              void onCleanupDispatchRef.current(agentId, sessionId);
            } else {
              void orpc.agents.sessions.end({ agentId, sessionId }).catch(() => undefined);
            }
          },
        });
        leaseRef.current = lease;
        onConnectedRef.current(
          { agentId: next.phase.agentId, sessionId: next.phase.sessionId },
          lease,
        );
      }
    });
    setState(flow.getState());

    return () => {
      unsubscribe();
      const liveFlow = flow as EnrollmentFlow;
      const token = {};
      pendingDisposalRef.current = {
        key,
        run: () => {
          // Superseded: a same-key replay already cancelled this exact
          // token (by nulling `pendingDisposalRef`, or by scheduling its OWN
          // later disposal that replaced this entry) before the microtask
          // queued below got a chance to run.
          if (pendingDisposalRef.current?.token !== token) return;
          pendingDisposalRef.current = null;
          liveFlow.close();
          if (flowRef.current === liveFlow) flowRef.current = null;
          // The handoff fired but the parent never accepted the lease
          // before this dialog unmounted (e.g. the whole page navigated
          // away in the same tick) — `flow.close()` alone does NOT dispose
          // an already `handed-off` session, since that phase is terminal
          // and ownership was meant to have already moved to the parent.
          // `lease.dispose()` is a no-op if the parent (or, later, the
          // sheet) already took ownership — this call is unconditional and
          // safe precisely because the lease is idempotent.
          const lease = leaseRef.current;
          if (lease?.getState() === "prepared") lease.dispose();
        },
        token,
      };
      queueMicrotask(() => pendingDisposalRef.current?.run());
    };
  }, [open, entry.id, orpc]);

  const copyCommand = async (command: string) => {
    await navigator.clipboard.writeText(command);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const { phase, canRetry } = state;
  // `mint-error` has no `currentMint` yet, so it can't resume via
  // `flow.retry()` (which requires one) — "Check again" there must mint a
  // fresh token the normal way instead (Final Review Clarifications:
  // "expired/mint failures need actual functional new token retry instead
  // of text nonexisting button" — this phase previously had no retry
  // control at all).
  const handleRetryClick = () => {
    if (phase.phase === "mint-error" || phase.phase === "expired") {
      flowRef.current?.start(entry.id, entry.id);
    } else {
      flowRef.current?.retry();
    }
  };
  const showRetry = canRetry || phase.phase === "mint-error" || phase.phase === "expired";
  // apply-context.txt #4: re-fires the failed disposal only — unrelated to
  // `handleRetryClick`'s "resume the enrollment attempt" meaning.
  const handleRetryCleanupClick = () => {
    flowRef.current?.retryCleanup();
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        onCloseAutoFocus={(event) => {
          // A successful handoff suppresses the dialog's own closing
          // autofocus — focus is about to move to the newly-mounted session
          // sheet (Decision 5's close-then-open), and letting Radix return
          // focus to the "Add" trigger here would immediately be stolen
          // again a moment later, a visible focus flicker. An ordinary
          // cancel (every other phase) keeps Radix's default behavior so
          // focus returns to the trigger as usual.
          if (phase.phase === "handed-off") {
            event.preventDefault();
          }
        }}
      >
        <DialogHeader>
          <DialogTitle>Add {entry.name}</DialogTitle>
          <DialogDescription>
            Run this on the machine where {entry.name} is installed.
          </DialogDescription>
        </DialogHeader>

        {/* Single live region for every phase's status text, so a screen
            reader announces each stage transition (machine online, agent
            registering, session starting, etc.) as it happens, not only the
            dialog's static title/description. */}
        <div role="status" aria-live="polite" className="contents">
          {phase.phase === "minting" && (
            <p className="text-sm text-muted-foreground">Creating a one-time enrollment token…</p>
          )}

          {phase.phase === "mint-error" && (
            <p className="text-sm text-destructive">
              Could not create an enrollment token. {phase.message}
            </p>
          )}

          {(phase.phase === "waiting-machine" || phase.phase === "expired") && (
            <div className="flex min-w-0 flex-col gap-3">
              <pre className="min-w-0 overflow-x-auto rounded-md bg-muted p-3 text-xs">
                <code>{phase.mint.command}</code>
              </pre>
              <Button size="sm" variant="secondary" onClick={() => copyCommand(phase.mint.command)}>
                {copied ? "Copied" : "Copy command"}
              </Button>
              {phase.phase === "waiting-machine" ? (
                <p className="text-sm text-muted-foreground">
                  Waiting for {entry.name} to connect back… this token expires at{" "}
                  {new Date(phase.mint.expiresAt).toLocaleTimeString()}.
                </p>
              ) : (
                <p className="text-sm text-destructive">
                  This token expired before the machine connected. Click "Check again" for a new
                  one.
                </p>
              )}
            </div>
          )}

          {(phase.phase === "waiting-agent" || phase.phase === "offline-reconnect") && (
            <div className="flex min-w-0 flex-col gap-3">
              <pre className="min-w-0 overflow-x-auto rounded-md bg-muted p-3 text-xs">
                <code>{phase.mint.command}</code>
              </pre>
              <p className="text-sm text-muted-foreground">
                {phase.phase === "waiting-agent"
                  ? `Machine connected — waiting for ${entry.name} to register…`
                  : `The machine went offline before ${entry.name} finished registering. Reconnect it to continue.`}
              </p>
            </div>
          )}

          {phase.phase === "registration-timed-out" && (
            <p className="text-sm text-destructive">
              No agent has registered on this machine yet. Click "Check again" once {entry.name} is
              running.
            </p>
          )}

          {phase.phase === "mismatched" && (
            <p className="text-sm text-destructive">
              This machine registered a different agent (
              {phase.agent.registrySlug ?? phase.agent.kind}) instead of {entry.name}.
            </p>
          )}

          {phase.phase === "agent-auth-required" && (
            <p className="text-sm text-destructive">
              {phase.agent.statusDetail ?? `${entry.name} needs you to sign in before it's ready.`}
            </p>
          )}

          {phase.phase === "agent-error" && (
            <p className="text-sm text-destructive">
              {phase.agent.statusDetail ?? `${entry.name} reported an error.`}
            </p>
          )}

          {phase.phase === "starting-session" && (
            <p className="text-sm text-muted-foreground">Agent connected — starting session…</p>
          )}

          {phase.phase === "preparation-timed-out" && (
            <p className="text-sm text-destructive">
              {canRetry
                ? 'Starting the session is taking longer than expected. Click "Check again" to retry.'
                : "Starting the session is taking longer than expected. Still waiting on the earlier attempt to finish before this can be retried."}
            </p>
          )}

          {phase.phase === "start-error" && (
            <p className="text-sm text-destructive">Could not start the session. {phase.message}</p>
          )}

          {phase.phase === "handed-off" && (
            <p className="text-sm text-foreground">Connected — opening the session…</p>
          )}

          {/* apply-context.txt #4: a best-effort cleanup of an abandoned/
              superseded session (Decision 7) can itself fail — transport
              rejection or `ok:false` — and must not vanish silently. This is
              independent of `phase`: the attempt that owned the started
              session may already be showing a LATER phase (e.g. a fresh
              `retry()`) by the time the stale disposal settles, so this
              banner is its own region rather than nested under one phase. */}
          {state.lastCleanup?.status === "failed" && (
            <p className="text-sm text-destructive">
              Could not confirm the earlier session was cleaned up.{" "}
              <Button
                variant="link"
                className="h-auto p-0 text-destructive"
                onClick={handleRetryCleanupClick}
              >
                Retry cleanup
              </Button>
            </p>
          )}
        </div>

        <DialogFooter className="gap-2">
          {showRetry && (
            <Button variant="secondary" onClick={handleRetryClick}>
              Check again
            </Button>
          )}
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {phase.phase === "handed-off" ? "Done" : "Close"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
