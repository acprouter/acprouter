"use client";

import type { AgentVO, MachineVO } from "@acprouter/contract";
import { Badge } from "kui/badge";
import { Button } from "kui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "kui/card";
import { useState } from "react";
import { AgentSessionSheet } from "./agent-session-sheet";
import { AgentStatusIndicator } from "./agent-status-indicator";
import { ConsumerConnectionDialog } from "./consumer-connection-dialog";

interface RegisteredAgentsListProps {
  agents: AgentVO[] | null;
  machines: MachineVO[] | null;
}

/**
 * Real registered agent rows (task #10) — the thing this task exists to
 * build, since every prior task left `acprouterAgents` empty. Shown ABOVE
 * the catalog's "Add" grid, matching spec §2b's "returning later" guidance:
 * a returning user sees their connected cards first, not the empty-state
 * add flow. Renders nothing while loading or once loaded-but-empty — the
 * catalog grid below already covers "nothing added yet".
 */
export function RegisteredAgentsList({ agents, machines }: RegisteredAgentsListProps) {
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
          />
        ))}
      </div>
    </div>
  );
}

function AgentCard({ agent, machineLabel }: { agent: AgentVO; machineLabel: string | null }) {
  const [sessionOpen, setSessionOpen] = useState(false);
  const [connectOpen, setConnectOpen] = useState(false);
  // Task #13 extends this from `bridged`-only to both real kinds — a
  // `remote-acp` (Buda) session goes through the SAME `sessions.*` oRPC
  // procedures and the SAME `AgentSessionSheet`/`useAgentSession` (both
  // already transport-agnostic; see `sessions-logic.ts`'s connection-
  // resolution split for where the two kinds actually diverge), so there is
  // no third UI path to add here — just the condition that used to
  // hard-code "only bridged."
  const canOpenSession = agent.status === "connected";

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
        {/* Always shown, never hidden — spec §5.6 point 5's literal
            acceptance bar: "the user must never be unsure what a remote
            agent can reach." `remote-acp` (Buda) legitimately has no `cwd`
            (§5.5a) and reads as "not applicable" rather than a missing
            value. */}
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
          {/* Task #14 — reachable regardless of live status: minting a key
              doesn't require the agent to be online right now (an external
              consumer might connect later, once it is). */}
          <Button size="sm" variant="ghost" onClick={() => setConnectOpen(true)}>
            Copy connection info
          </Button>
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
    </Card>
  );
}
