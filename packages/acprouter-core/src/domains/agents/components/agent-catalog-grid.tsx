"use client";

import type { AgentCatalogEntryVO } from "@acprouter/contract";
import { Badge } from "kui/badge";
import { Button } from "kui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "kui/card";
import { useState } from "react";
import { AddAgentDialog } from "./add-agent-dialog";
import { AddRemoteAgentDialog } from "./add-remote-agent-dialog";

interface AgentCatalogGridProps {
  entries: AgentCatalogEntryVO[];
  /** Called once enrollment completes — the parent refetches `agents.list`/`machines.list` rather than this grid tracking connection state itself (task #10). */
  onConnected: () => void;
}

/**
 * Always-visible "add another" grid, one card per catalog entry (spec §2b) —
 * NOT a status display. It used to be the only place the Agents page said
 * anything about connection state at all, permanently reading "Not added"
 * regardless of reality (the bug task #10 exists to fix); real live state
 * now lives in `RegisteredAgentsList`, above this grid on the page. `Add`
 * opens the enrollment dialog (`AddAgentDialog`, mint-token-then-poll) for
 * `bridged` entries and the direct connect dialog (`AddRemoteAgentDialog`,
 * task #13) for `remote-acp` entries — both kinds are real now, per spec
 * §2b's two Add flows.
 */
export function AgentCatalogGrid({ entries, onConnected }: AgentCatalogGridProps) {
  const [openEntryId, setOpenEntryId] = useState<string | null>(null);
  const openEntry = entries.find((entry) => entry.id === openEntryId) ?? null;

  return (
    <>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {entries.map((entry) => (
          <Card key={entry.id}>
            <CardHeader>
              <div className="flex items-center gap-2">
                <CardTitle>{entry.name}</CardTitle>
                <Badge variant="secondary">{entry.kind === "bridged" ? "Local" : "Remote"}</Badge>
                {entry.version && <Badge variant="outline">v{entry.version}</Badge>}
              </div>
              <CardDescription>{entry.description}</CardDescription>
            </CardHeader>
            <CardContent>
              <span className="text-sm text-muted-foreground">
                {entry.kind === "bridged"
                  ? "Connect a machine to add this agent."
                  : "Paste an endpoint and API key to add this agent."}
              </span>
            </CardContent>
            <CardFooter>
              <Button size="sm" onClick={() => setOpenEntryId(entry.id)}>
                Add
              </Button>
            </CardFooter>
          </Card>
        ))}
      </div>

      {openEntry && openEntry.kind === "bridged" && (
        <AddAgentDialog
          entry={openEntry}
          open={openEntry !== null}
          onOpenChange={(open) => {
            if (!open) setOpenEntryId(null);
          }}
          onConnected={onConnected}
        />
      )}

      {openEntry && openEntry.kind === "remote-acp" && (
        <AddRemoteAgentDialog
          entry={openEntry}
          open={openEntry !== null}
          onOpenChange={(open) => {
            if (!open) setOpenEntryId(null);
          }}
          onConnected={onConnected}
        />
      )}
    </>
  );
}
