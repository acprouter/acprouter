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
import { Input } from "kui/input";
import { useEffect, useState } from "react";
import { useAcprouterOrpc } from "../client";

/** Spec §2b: "an endpoint field (pre-filled with the public Buda ACP URL)" — production Buda is `https://buda.im` (per other specs in this repo), so this is `wss://buda.im/api/acp`. The dialog has no separate agentId field (spec is explicit the Add flow is just endpoint + API key), so the user appends their own `?agentId=` onto this value before submitting. */
const DEFAULT_BUDA_ENDPOINT = "wss://buda.im/api/acp";

interface AddRemoteAgentDialogProps {
  entry: AgentCatalogEntryVO;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Same contract as `AddAgentDialog`'s prop of the same name — the parent refetches `agents.list`/`machines.list` rather than this dialog tracking connection state itself (task #10's pattern). */
  onConnected: () => void;
}

type SubmitState =
  | { phase: "idle" }
  | { phase: "connecting" }
  | { phase: "error"; message: string };

/**
 * The `remote-acp` Add flow (spec §2b, Story B): "Different dialog body, no
 * CLI involved: an endpoint field... and an API key field. Submit connects
 * immediately — there is no detection step because there is no process to
 * detect." Unlike `AddAgentDialog`'s mint-then-poll flow, this dialog does
 * exactly one thing: call `agents.agents.connectRemoteAcp`, which itself
 * dials the endpoint for real before returning (`remote-agents-logic.ts`).
 * Only closes on a real, proven success — a failure keeps the dialog open
 * with the SPECIFIC backend error shown inline (spec §3's failure-mode bar)
 * so the user can fix the endpoint/key and retry without losing their input.
 */
export function AddRemoteAgentDialog({
  entry,
  open,
  onOpenChange,
  onConnected,
}: AddRemoteAgentDialogProps) {
  const orpc = useAcprouterOrpc();
  const [label, setLabel] = useState(entry.name);
  const [endpoint, setEndpoint] = useState(DEFAULT_BUDA_ENDPOINT);
  const [apiKey, setApiKey] = useState("");
  const [state, setState] = useState<SubmitState>({ phase: "idle" });

  useEffect(() => {
    if (!open) return;
    setLabel(entry.name);
    setEndpoint(DEFAULT_BUDA_ENDPOINT);
    setApiKey("");
    setState({ phase: "idle" });
  }, [open, entry.name]);

  const connecting = state.phase === "connecting";
  const canSubmit = !connecting && endpoint.trim().length > 0 && apiKey.trim().length > 0;

  const submit = async () => {
    setState({ phase: "connecting" });
    try {
      await orpc.agents.agents.connectRemoteAcp({
        label: label.trim() || entry.name,
        endpoint: endpoint.trim(),
        apiKey: apiKey.trim(),
      });
      onConnected();
      onOpenChange(false);
    } catch (error) {
      setState({
        phase: "error",
        message: error instanceof Error ? error.message : "Could not connect to that endpoint.",
      });
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add {entry.name}</DialogTitle>
          <DialogDescription>
            {entry.name} already speaks ACP over WebSocket — nothing to install. Paste an endpoint
            and an API key.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-1.5">
            <label className="text-sm font-medium text-foreground" htmlFor="remote-agent-endpoint">
              Endpoint
            </label>
            <Input
              id="remote-agent-endpoint"
              value={endpoint}
              onChange={(e) => setEndpoint(e.target.value)}
              placeholder={DEFAULT_BUDA_ENDPOINT}
              disabled={connecting}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <label className="text-sm font-medium text-foreground" htmlFor="remote-agent-api-key">
              API key
            </label>
            <Input
              id="remote-agent-api-key"
              type="password"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder="sk_..."
              disabled={connecting}
            />
          </div>
          {state.phase === "error" && (
            // The SPECIFIC error `connectRemoteAcpAgent` threw (unreachable
            // host / rejected during initialize / handshake timeout — see
            // `remote-agents-logic.ts`), never a generic string — and the
            // dialog stays open so the user can fix the field and retry
            // without losing what they already typed.
            <p className="text-sm text-destructive">{state.message}</p>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={connecting}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={!canSubmit}>
            {connecting ? "Connecting…" : "Connect"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
