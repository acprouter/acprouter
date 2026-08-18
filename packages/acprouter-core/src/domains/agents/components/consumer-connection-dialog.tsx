"use client";

import type { AgentVO, ConsumerApiKeyVO } from "@acprouter/contract";
import { Button } from "kui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "kui/dialog";
import { useEffect, useState } from "react";
import { useAcprouterOrpc } from "../client";

interface ConsumerConnectionDialogProps {
  agent: AgentVO;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

type DialogState =
  | { phase: "loading" }
  | { phase: "listed"; keys: ConsumerApiKeyVO[] }
  | { phase: "minted"; url: string; rawKey: string; keys: ConsumerApiKeyVO[] }
  | { phase: "error"; message: string };

/**
 * Task #14's minimal dashboard affordance — spec §5.3 point 1's `wss://
 * <router>/api/acp?agentId=<id>` surface has no dedicated screen of its own
 * in this task's scope (deliberately: "keep this UI addition small, this
 * task is primarily a backend/protocol task"), so this is a small dialog
 * reachable from the same agent card `AgentSessionSheet` already opens from,
 * not a new page. Same "shown once, copyable" UX precedent as
 * `AddAgentDialog`'s enrollment command — the raw key is never retrievable
 * again after this dialog closes, matching `mintConsumerApiKey`'s contract.
 */
export function ConsumerConnectionDialog({
  agent,
  open,
  onOpenChange,
}: ConsumerConnectionDialogProps) {
  const orpc = useAcprouterOrpc();
  const [state, setState] = useState<DialogState>({ phase: "loading" });
  const [copied, setCopied] = useState<"url" | "key" | null>(null);

  useEffect(() => {
    if (!open) return;
    setState({ phase: "loading" });
    setCopied(null);
    orpc.agents.consumerKeys
      .list({ agentId: agent.id })
      .then((keys) => setState({ phase: "listed", keys }))
      .catch((error: unknown) => {
        setState({
          phase: "error",
          message: error instanceof Error ? error.message : "Could not load connection keys.",
        });
      });
  }, [open, agent.id, orpc]);

  const mint = () => {
    orpc.agents.consumerKeys
      .mint({ agentId: agent.id })
      .then((minted) =>
        setState({
          phase: "minted",
          url: minted.connectionUrl,
          rawKey: minted.rawKey,
          keys: [
            minted.key,
            ...(state.phase === "listed" || state.phase === "minted" ? state.keys : []),
          ],
        }),
      )
      .catch((error: unknown) => {
        setState({
          phase: "error",
          message: error instanceof Error ? error.message : "Could not mint a connection key.",
        });
      });
  };

  const revoke = (id: string) => {
    orpc.agents.consumerKeys
      .revoke({ id })
      .then(() => {
        setState((prev) =>
          prev.phase === "listed" || prev.phase === "minted"
            ? { ...prev, keys: prev.keys.filter((k) => k.id !== id) }
            : prev,
        );
      })
      .catch(() => undefined);
  };

  const copy = async (value: string, which: "url" | "key") => {
    await navigator.clipboard.writeText(value);
    setCopied(which);
    setTimeout(() => setCopied(null), 2000);
  };

  const keys = state.phase === "listed" || state.phase === "minted" ? state.keys : [];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Connect an external ACP consumer</DialogTitle>
          <DialogDescription>
            Drive "{agent.label}" from Zed, Busabase, or any real ACP client over WebSocket — not
            this dashboard's own prompt box.
          </DialogDescription>
        </DialogHeader>

        {state.phase === "loading" && <p className="text-sm text-muted-foreground">Loading…</p>}
        {state.phase === "error" && <p className="text-sm text-destructive">{state.message}</p>}

        {state.phase === "minted" && (
          <div className="flex min-w-0 flex-col gap-2">
            <p className="text-sm text-foreground">
              Copy this key now — it will not be shown again.
            </p>
            <pre className="min-w-0 overflow-x-auto rounded-md bg-muted p-3 text-xs">
              <code>{state.url}</code>
            </pre>
            <Button size="sm" variant="secondary" onClick={() => copy(state.url, "url")}>
              {copied === "url" ? "Copied" : "Copy URL"}
            </Button>
            <pre className="min-w-0 overflow-x-auto rounded-md bg-muted p-3 text-xs">
              <code>{state.rawKey}</code>
            </pre>
            <Button size="sm" variant="secondary" onClick={() => copy(state.rawKey, "key")}>
              {copied === "key" ? "Copied" : "Copy key"}
            </Button>
          </div>
        )}

        {(state.phase === "listed" || state.phase === "minted") && (
          <div className="flex flex-col gap-2">
            <Button size="sm" variant="outline" onClick={mint}>
              Mint a new connection key
            </Button>
            {keys.length > 0 && (
              <ul className="flex flex-col gap-1">
                {keys.map((key) => (
                  <li
                    key={key.id}
                    className="flex items-center justify-between gap-2 text-xs text-muted-foreground"
                  >
                    <span>
                      {key.label ?? key.id} — minted {new Date(key.createdAt).toLocaleString()}
                    </span>
                    <Button size="sm" variant="ghost" onClick={() => revoke(key.id)}>
                      Revoke
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
