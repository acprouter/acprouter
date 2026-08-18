"use client";

import type {
  AgentCatalogEntryVO,
  MachineVO,
  MintEnrollmentTokenOutput,
} from "@acprouter/contract";
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

const POLL_INTERVAL_MS = 2000;

interface AddAgentDialogProps {
  entry: AgentCatalogEntryVO;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Called once enrollment completes — the parent refetches shared list state (task #10), it doesn't need the raw machine back. */
  onConnected: () => void;
}

type DialogState =
  | { phase: "minting" }
  | { phase: "waiting"; mint: MintEnrollmentTokenOutput }
  | { phase: "connected"; machine: MachineVO }
  | { phase: "expired"; mint: MintEnrollmentTokenOutput }
  | { phase: "error"; message: string };

/**
 * The bridged-agent Add flow (spec §2b): mint a single-use token, show the
 * exact command to paste, then poll until that machine appears online — with
 * an explicit expiry state instead of spinning forever (spec §3's failure
 * mode, and task #5's acceptance bar).
 */
export function AddAgentDialog({ entry, open, onOpenChange, onConnected }: AddAgentDialogProps) {
  const orpc = useAcprouterOrpc();
  const [state, setState] = useState<DialogState>({ phase: "minting" });
  const [copied, setCopied] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (!open) return;
    setState({ phase: "minting" });
    setCopied(false);

    let cancelled = false;
    orpc.agents.machines
      .mint({ intendedAgentSlug: entry.id })
      .then((mint) => {
        if (!cancelled) setState({ phase: "waiting", mint });
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setState({
            phase: "error",
            message:
              error instanceof Error ? error.message : "Could not create an enrollment token.",
          });
        }
      });

    return () => {
      cancelled = true;
    };
  }, [open, entry.id, orpc]);

  useEffect(() => {
    if (state.phase !== "waiting") return;
    const { mint } = state;
    const expiresAt = new Date(mint.expiresAt).getTime();

    pollRef.current = setInterval(async () => {
      if (Date.now() > expiresAt) {
        setState({ phase: "expired", mint });
        return;
      }
      try {
        const machines = await orpc.agents.machines.list();
        const machine = machines.find((m) => m.id === mint.machineId && m.status === "online");
        if (machine) {
          setState({ phase: "connected", machine });
          onConnected();
        }
      } catch {
        // A transient poll failure isn't the same as enrollment failing —
        // keep waiting rather than flipping to an error state on one miss.
      }
    }, POLL_INTERVAL_MS);

    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [state, onConnected, orpc]);

  useEffect(() => {
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, []);

  const copyCommand = async (command: string) => {
    await navigator.clipboard.writeText(command);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add {entry.name}</DialogTitle>
          <DialogDescription>
            Run this on the machine where {entry.name} is installed.
          </DialogDescription>
        </DialogHeader>

        {state.phase === "minting" && (
          <p className="text-sm text-muted-foreground">Creating a one-time enrollment token…</p>
        )}

        {(state.phase === "waiting" || state.phase === "expired") && (
          <div className="flex min-w-0 flex-col gap-3">
            <pre className="min-w-0 overflow-x-auto rounded-md bg-muted p-3 text-xs">
              <code>{state.mint.command}</code>
            </pre>
            <Button size="sm" variant="secondary" onClick={() => copyCommand(state.mint.command)}>
              {copied ? "Copied" : "Copy command"}
            </Button>
            {state.phase === "waiting" ? (
              <p className="text-sm text-muted-foreground">
                Waiting for {entry.name} to connect back… this token expires at{" "}
                {new Date(state.mint.expiresAt).toLocaleTimeString()}.
              </p>
            ) : (
              <p className="text-sm text-destructive">
                This token expired before the machine connected. Close this dialog and click Add
                again for a new one.
              </p>
            )}
          </div>
        )}

        {state.phase === "connected" && (
          <p className="text-sm text-foreground">
            Connected — <span className="font-medium">{state.machine.label}</span> is online.
          </p>
        )}

        {state.phase === "error" && <p className="text-sm text-destructive">{state.message}</p>}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {state.phase === "connected" ? "Done" : "Close"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
