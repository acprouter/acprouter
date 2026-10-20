"use client";

import type { AgentCatalogEntryVO } from "@acprouter/contract";
import { Badge } from "kui/badge";
import { Button } from "kui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "kui/card";
import { useState } from "react";
import type { SessionLease } from "../utils/session-lease";
import { AddAgentDialog } from "./add-agent-dialog";
import { AddBudaOAuthDialog } from "./add-buda-oauth-dialog";
import { AddRemoteAgentDialog } from "./add-remote-agent-dialog";

/** The one `remote-acp` catalog entry that's actually Buda (registry-sync.ts) — OAuth is a Buda-specific shortcut, not a generic `remote-acp` behavior. Any other `remote-acp` entry keeps the manual endpoint/API-key dialog as its only Add path. */
const BUDA_OAUTH_ENTRY_ID = "buda";

interface AgentCatalogGridProps {
  entries: AgentCatalogEntryVO[];
  /**
   * Called once enrollment completes — the parent always refetches
   * `agents.list`/`machines.list` (task #10). For the `bridged` Add flow
   * only, a payload is also passed once `sessions.start` has genuinely
   * resolved (design.md Decision 3/6): `{ agentId, sessionId }`, the
   * already-live session to adopt, together with the `SessionLease`
   * (Final Review Clarifications: ownership transfers on `lease.accept()`,
   * not merely on this callback being invoked). `remote-acp`/Buda OAuth
   * keep calling this with no payload and no lease — refetch-only,
   * unchanged, no auto-open (out of scope per proposal.md).
   */
  onConnected: (result?: { agentId: string; sessionId: string }, lease?: SessionLease) => void;
  /**
   * Enables the Buda OAuth popup shortcut for the Buda catalog entry.
   * Defaults to `false`; host apps must opt in only when they provide the
   * `/api/agents/buda/oauth/*` routes this flow needs. Otherwise every Buda
   * card uses the manual endpoint/API-key dialog (`AddRemoteAgentDialog`)
   * to avoid opening a popup against a 404.
   */
  budaOAuthEnabled?: boolean;
  /**
   * Controls the bridged Add dialog's open state from the parent
   * (design.md Decision 5) — needed so `AgentsPageClientBody` can close it
   * itself the instant `onConnected`'s payload arrives, ahead of mounting
   * the handoff sheet. `remote-acp`/Buda OAuth dialogs are unaffected and
   * keep their own fully-local `openEntryId`/`manualEntryId` state; only the
   * bridged entry's open-ness is lifted.
   */
  bridgedDialogEntryId?: string | null;
  onBridgedDialogEntryIdChange?: (entryId: string | null) => void;
  /**
   * Forwarded unchanged to `AddAgentDialog`'s own `onCleanupDispatch` (see
   * its doc comment) — `AgentsPageClientBody`'s parent-owned
   * `createCleanupTracker` instance, so a disposal failure survives this
   * dialog unmounting. `undefined` for any host that doesn't supply one;
   * `AddAgentDialog` falls back to calling `sessions.end` itself in that
   * case, unchanged from before this prop existed.
   */
  onCleanupDispatch?: (agentId: string, sessionId: string) => Promise<{ ok: boolean }>;
}

/**
 * Always-visible "add another" grid, one card per catalog entry (spec §2b) —
 * NOT a status display. It used to be the only place the Agents page said
 * anything about connection state at all, permanently reading "Not added"
 * regardless of reality (the bug task #10 exists to fix); real live state
 * now lives in `RegisteredAgentsList`, above this grid on the page. `Add`
 * opens the enrollment dialog (`AddAgentDialog`, mint-token-then-poll) for
 * `bridged` entries; for `remote-acp` entries it opens the Buda OAuth
 * popup flow (`AddBudaOAuthDialog`, PUL-335) for the Buda entry
 * specifically when `budaOAuthEnabled` is true, or the manual
 * endpoint/API-key dialog (`AddRemoteAgentDialog`, task #13) otherwise —
 * both kinds are real now, per spec §2b's two Add flows.
 */
export function AgentCatalogGrid({
  entries,
  onConnected,
  budaOAuthEnabled = false,
  bridgedDialogEntryId,
  onBridgedDialogEntryIdChange,
  onCleanupDispatch,
}: AgentCatalogGridProps) {
  const [localOpenEntryId, setLocalOpenEntryId] = useState<string | null>(null);
  const [manualEntryId, setManualEntryId] = useState<string | null>(null);
  // The bridged dialog's open-ness is controlled by the parent when it
  // supplies both props (design.md Decision 5); every other Add dialog below
  // keeps using `localOpenEntryId`/`manualEntryId` exactly as before — only
  // the bridged seam is lifted, nothing else changes shape.
  const isBridgedControlled = onBridgedDialogEntryIdChange !== undefined;
  const bridgedOpenEntryId = isBridgedControlled
    ? (bridgedDialogEntryId ?? null)
    : localOpenEntryId;
  const setBridgedOpenEntryId = isBridgedControlled
    ? (onBridgedDialogEntryIdChange as (entryId: string | null) => void)
    : setLocalOpenEntryId;

  const openEntry = entries.find((entry) => entry.id === localOpenEntryId) ?? null;
  const bridgedOpenEntry = entries.find((entry) => entry.id === bridgedOpenEntryId) ?? null;
  const manualEntry = entries.find((entry) => entry.id === manualEntryId) ?? null;
  const isBudaOAuthEntry = (entry: AgentCatalogEntryVO) =>
    budaOAuthEnabled && entry.kind === "remote-acp" && entry.id === BUDA_OAUTH_ENTRY_ID;

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
                  : isBudaOAuthEntry(entry)
                    ? "Connect with your Buda account — no API key needed."
                    : "Paste an endpoint and API key to add this agent."}
              </span>
            </CardContent>
            <CardFooter>
              <Button
                size="sm"
                onClick={() =>
                  entry.kind === "bridged"
                    ? setBridgedOpenEntryId(entry.id)
                    : setLocalOpenEntryId(entry.id)
                }
              >
                Add
              </Button>
            </CardFooter>
          </Card>
        ))}
      </div>

      {bridgedOpenEntry && bridgedOpenEntry.kind === "bridged" && (
        <AddAgentDialog
          entry={bridgedOpenEntry}
          open={bridgedOpenEntry !== null}
          onOpenChange={(open) => {
            if (!open) setBridgedOpenEntryId(null);
          }}
          onConnected={(result, lease) => onConnected(result, lease)}
          onCleanupDispatch={onCleanupDispatch}
        />
      )}

      {openEntry && openEntry.kind === "remote-acp" && isBudaOAuthEntry(openEntry) && (
        <AddBudaOAuthDialog
          entry={openEntry}
          open={openEntry !== null}
          onOpenChange={(open) => {
            if (!open) setLocalOpenEntryId(null);
          }}
          onConnected={() => onConnected()}
          onUseManualInstead={() => {
            setManualEntryId(openEntry.id);
            setLocalOpenEntryId(null);
          }}
        />
      )}

      {openEntry && openEntry.kind === "remote-acp" && !isBudaOAuthEntry(openEntry) && (
        <AddRemoteAgentDialog
          entry={openEntry}
          open={openEntry !== null}
          onOpenChange={(open) => {
            if (!open) setLocalOpenEntryId(null);
          }}
          onConnected={() => onConnected()}
        />
      )}

      {manualEntry && (
        <AddRemoteAgentDialog
          entry={manualEntry}
          open={manualEntry !== null}
          onOpenChange={(open) => {
            if (!open) setManualEntryId(null);
          }}
          onConnected={() => onConnected()}
        />
      )}
    </>
  );
}
