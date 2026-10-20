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
import { useCallback, useEffect, useRef, useState } from "react";

const POPUP_TIMEOUT_MS = 5 * 60 * 1000;

interface AddBudaOAuthDialogProps {
  entry: AgentCatalogEntryVO;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Parent refetches agents.list rather than this dialog tracking connection state itself (same contract as the other Add dialogs). */
  onConnected: () => void;
  /** Lets the parent fall back to the manual endpoint/API-key dialog without this component knowing about it. */
  onUseManualInstead: () => void;
}

type DialogState =
  | { phase: "idle" }
  | { phase: "connecting" }
  | { phase: "error"; message: string };

/**
 * Buda-specific OAuth shortcut for the `remote-acp` Add flow (PUL-335):
 * opens `/api/agents/buda/oauth/start` in a popup and waits for its
 * callback page's `postMessage`. Manual endpoint/API-key entry
 * (`AddRemoteAgentDialog`) stays the generic path for any other ACP
 * endpoint and the fallback if the popup is blocked or times out.
 */
export function AddBudaOAuthDialog({
  entry,
  open,
  onOpenChange,
  onConnected,
  onUseManualInstead,
}: AddBudaOAuthDialogProps) {
  const [state, setState] = useState<DialogState>({ phase: "idle" });
  const popupRef = useRef<Window | null>(null);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // Held in a ref (not a local inside `startConnect`) so `cleanup` can
  // always remove it, including on close/unmount — a path that never runs
  // through any of `onMessage`'s own branches below, which is exactly the
  // path that used to leak this listener forever.
  const messageListenerRef = useRef<((event: MessageEvent) => void) | null>(null);

  const cleanup = useCallback(() => {
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
    if (pollRef.current) clearInterval(pollRef.current);
    timeoutRef.current = null;
    pollRef.current = null;
    popupRef.current?.close();
    popupRef.current = null;
    if (messageListenerRef.current) {
      window.removeEventListener("message", messageListenerRef.current);
      messageListenerRef.current = null;
    }
  }, []);

  useEffect(() => {
    if (!open) {
      cleanup();
      setState({ phase: "idle" });
    }
    return cleanup;
  }, [open, cleanup]);

  const startConnect = () => {
    setState({ phase: "connecting" });
    const popup = window.open(
      "/api/agents/buda/oauth/start",
      "acprouter-buda-oauth",
      "width=480,height=640",
    );
    if (!popup) {
      setState({
        phase: "error",
        message: "Your browser blocked the popup. Allow popups for this site, or connect manually.",
      });
      return;
    }
    popupRef.current = popup;

    const onMessage = (event: MessageEvent) => {
      // Only the same-origin callback page we opened may complete this
      // flow — a cross-origin postMessage (from an unrelated tab/extension)
      // must never be mistaken for a real Buda connection result.
      if (event.origin !== window.location.origin || event.source !== popupRef.current) return;
      const data = event.data as { type?: string; message?: string } | null;
      if (data?.type === "acprouter:buda-connected") {
        cleanup();
        onConnected();
        onOpenChange(false);
      } else if (data?.type === "acprouter:buda-error") {
        cleanup();
        setState({ phase: "error", message: data.message || "Could not connect to Buda." });
      }
    };
    messageListenerRef.current = onMessage;
    window.addEventListener("message", onMessage);

    // The popup can be closed by the user without ever posting a message
    // (clicking the OS close button mid-flow) — detect that so the dialog
    // doesn't spin on "Connecting…" forever.
    pollRef.current = setInterval(() => {
      if (popupRef.current?.closed) {
        cleanup();
        setState({ phase: "error", message: "The connection window was closed before finishing." });
      }
    }, 500);

    timeoutRef.current = setTimeout(() => {
      cleanup();
      setState({ phase: "error", message: "This took too long. Try again, or connect manually." });
    }, POPUP_TIMEOUT_MS);
  };

  const connecting = state.phase === "connecting";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Connect {entry.name}</DialogTitle>
          <DialogDescription>
            Sign in to Buda in a popup to connect it — no API key to copy.
          </DialogDescription>
        </DialogHeader>

        {state.phase === "error" && <p className="text-sm text-destructive">{state.message}</p>}

        <DialogFooter className="flex items-center justify-between sm:justify-between">
          <Button variant="link" onClick={onUseManualInstead}>
            Connect manually instead
          </Button>
          <div className="flex gap-2">
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button onClick={startConnect} disabled={connecting}>
              {connecting ? "Connecting…" : "Connect"}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
