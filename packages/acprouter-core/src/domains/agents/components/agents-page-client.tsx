"use client";

import type { AgentCatalogEntryVO, AgentVO, MachineVO } from "@acprouter/contract";
import { useCallback, useEffect, useState } from "react";
import { AcprouterOrpcProvider, useAcprouterOrpc } from "../client";
import { AgentCatalogGrid } from "./agent-catalog-grid";
import { MachinesList } from "./machines-list";
import { RegisteredAgentsList } from "./registered-agents-list";

const REFRESH_INTERVAL_MS = 5000;

interface AgentsPageClientProps {
  entries: AgentCatalogEntryVO[];
  /** Base URL the oRPC client sends requests to, e.g. `/api/rpc` — supplied by whichever app mounts this component, never hardcoded in this package. */
  apiBasePath: string;
}

/**
 * Top-level composed page component. Owns the oRPC client for this whole
 * subtree via `AcprouterOrpcProvider` (base path supplied by the host app),
 * so every descendant — this component included, through `useAcprouterOrpc`
 * — shares ONE client instance instead of each file constructing its own.
 */
export function AgentsPageClient({ entries, apiBasePath }: AgentsPageClientProps) {
  return (
    <AcprouterOrpcProvider apiBasePath={apiBasePath}>
      <AgentsPageClientBody entries={entries} />
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
 */
function AgentsPageClientBody({ entries }: { entries: AgentCatalogEntryVO[] }) {
  const orpc = useAcprouterOrpc();
  const [agents, setAgents] = useState<AgentVO[] | null>(null);
  const [machines, setMachines] = useState<MachineVO[] | null>(null);

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

  return (
    <div className="flex flex-col gap-6">
      <RegisteredAgentsList agents={agents} machines={machines} />
      <AgentCatalogGrid entries={entries} onConnected={refresh} />
      <MachinesList machines={machines} />
    </div>
  );
}
