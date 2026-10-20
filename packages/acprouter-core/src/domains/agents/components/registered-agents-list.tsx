"use client";

import type { AgentVO, MachineVO } from "@acprouter/contract";
import { Badge } from "kui/badge";
import { Button } from "kui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "kui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "kui/dialog";
import { type RefObject, useRef, useState } from "react";
import { useAcprouterOrpc } from "../client";
import { AgentSessionSheet } from "./agent-session-sheet";
import { AgentStatusIndicator } from "./agent-status-indicator";
import { ConsumerConnectionDialog } from "./consumer-connection-dialog";

interface RegisteredAgentsListProps {
  agents: AgentVO[] | null;
  machines: MachineVO[] | null;
  /** Called once a removal succeeds — the parent re-polls `agents.list`/`machines.list` the same way `AgentCatalogGrid`'s `onConnected` already does, so there is one refresh path for the whole page, not a second ad hoc refetch. */
  onRemoved: () => void;
}

/**
 * Registered agent rows, shown ABOVE the catalog's "Add" grid so a
 * returning user sees their connected cards first, not the empty-state add
 * flow. Renders nothing while loading or once loaded-but-empty — the
 * catalog grid below already covers "nothing added yet".
 */
export function RegisteredAgentsList({ agents, machines, onRemoved }: RegisteredAgentsListProps) {
  if (!agents || agents.length === 0) return null;

  const machineLabelById = new Map((machines ?? []).map((m) => [m.id, m.label]));

  return (
    <div className="flex flex-col gap-2">
      <h2 className="text-sm font-medium text-muted-foreground">Your agents</h2>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {agents.map((agent) => (
          <AgentCard
            key={agent.id}
            agent={agent}
            machineLabel={agent.machineId ? (machineLabelById.get(agent.machineId) ?? null) : null}
            onRemoved={onRemoved}
          />
        ))}
      </div>
    </div>
  );
}

function AgentCard({
  agent,
  machineLabel,
  onRemoved,
}: {
  agent: AgentVO;
  machineLabel: string | null;
  onRemoved: () => void;
}) {
  const [sessionOpen, setSessionOpen] = useState(false);
  const [connectOpen, setConnectOpen] = useState(false);
  const [removeOpen, setRemoveOpen] = useState(false);
  const removeButtonRef = useRef<HTMLButtonElement>(null);
  // A `remote-acp` (Buda) session goes through the SAME `sessions.*` oRPC
  // procedures and the SAME `AgentSessionSheet`/`useAgentSession` (both
  // already transport-agnostic; see `sessions-logic.ts`'s connection-
  // resolution split for where the two kinds actually diverge), so there is
  // no third UI path to add here.
  const canOpenSession = agent.status === "connected";
  // Eligible ONLY for `disconnected`, not `auth_required`/`error` either:
  // the capability's whole purpose is clearing a stale, fully-unreachable
  // enrollment, and the backend's `removeAgent` rejects anything else with
  // `{ ok: false }`, so this mirrors that exact gate rather than a broader
  // "not connected" one.
  const canRemove = agent.status === "disconnected";

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-2">
          <CardTitle>{agent.label}</CardTitle>
          <Badge variant="secondary">{agent.kind === "bridged" ? "Local" : "Remote"}</Badge>
          {agent.detectedVersion && <Badge variant="outline">v{agent.detectedVersion}</Badge>}
        </div>
        {machineLabel && <CardDescription>on {machineLabel}</CardDescription>}
      </CardHeader>
      <CardContent className="flex flex-col gap-2">
        <AgentStatusIndicator status={agent.status} statusDetail={agent.statusDetail} />
        {/* Always shown, never hidden — the user must never be unsure what
            a remote agent can reach. `remote-acp` (Buda) legitimately has no
            `cwd` and reads as "not applicable" rather than a missing value. */}
        <div className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
          <span className="shrink-0 font-medium text-foreground">Directory:</span>
          <code className="truncate">
            {agent.cwd ?? (agent.kind === "remote-acp" ? "not applicable" : "not reported yet")}
          </code>
        </div>
        <div className="flex gap-2">
          {canOpenSession && (
            <Button size="sm" variant="outline" onClick={() => setSessionOpen(true)}>
              Open
            </Button>
          )}
          {/* Reachable regardless of live status: minting a key doesn't
              require the agent to be online right now (an external consumer
              might connect later, once it is). */}
          <Button size="sm" variant="ghost" onClick={() => setConnectOpen(true)}>
            Copy connection info
          </Button>
          {canRemove && (
            <Button
              ref={removeButtonRef}
              size="sm"
              variant="ghost"
              onClick={() => setRemoveOpen(true)}
            >
              Remove
            </Button>
          )}
        </div>
      </CardContent>
      {canOpenSession && (
        <AgentSessionSheet
          agentId={agent.id}
          agentLabel={agent.label}
          open={sessionOpen}
          onOpenChange={setSessionOpen}
        />
      )}
      <ConsumerConnectionDialog agent={agent} open={connectOpen} onOpenChange={setConnectOpen} />
      {canRemove && (
        <RemoveAgentDialog
          agent={agent}
          open={removeOpen}
          onOpenChange={setRemoveOpen}
          onRemoved={onRemoved}
          triggerRef={removeButtonRef}
        />
      )}
    </Card>
  );
}

function RemoveAgentDialog({
  agent,
  open,
  onOpenChange,
  onRemoved,
  triggerRef,
}: {
  agent: AgentVO;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onRemoved: () => void;
  triggerRef: RefObject<HTMLButtonElement | null>;
}) {
  const orpc = useAcprouterOrpc();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleOpenChange = (next: boolean) => {
    if (pending) return;
    if (next) setError(null);
    onOpenChange(next);
  };

  const confirmRemove = () => {
    if (pending) return;
    setPending(true);
    setError(null);
    orpc.agents.agents
      .remove({ id: agent.id })
      .then((result) => {
        setPending(false);
        if (!result.ok) {
          setError(
            "This agent is no longer eligible to remove — it may have reconnected. Refresh and try again.",
          );
          return;
        }
        onOpenChange(false);
        onRemoved();
      })
      .catch((err: unknown) => {
        setPending(false);
        setError(err instanceof Error ? err.message : "Could not remove this agent.");
      });
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          triggerRef.current?.focus();
        }}
      >
        <DialogHeader>
          <DialogTitle>Remove "{agent.label}"?</DialogTitle>
          <DialogDescription>
            This removes the agent's enrollment from your dashboard. It does not require the agent's
            runtime to be reachable, and does not affect its machine or any other agent on it. Prior
            sessions and usage history are kept.
          </DialogDescription>
        </DialogHeader>

        {error && (
          <p className="text-sm text-destructive" role="alert">
            {error}
          </p>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => handleOpenChange(false)} disabled={pending}>
            Cancel
          </Button>
          <Button variant="destructive" onClick={confirmRemove} disabled={pending}>
            {pending ? "Removing…" : "Remove"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
