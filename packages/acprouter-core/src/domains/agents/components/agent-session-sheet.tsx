"use client";

import { Button } from "kui/button";
import { Input } from "kui/input";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "kui/sheet";
import { useEffect, useRef, useState } from "react";
import { useAgentSession } from "../hooks/use-agent-session";
import { AgentSessionTranscript } from "./agent-session-transcript";

interface AgentSessionSheetProps {
  agentId: string;
  agentLabel: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * The "prove the agent works / administer it" prompt box (spec §9 Phase 1
 * point 4, §1.1) — deliberately minimal: one text box, a transcript, tool
 * calls and permission requests as distinct cards. Mounted only while
 * `open`, so a fresh `useAgentSession` (and its `session/new`) is created
 * each time the sheet opens rather than one session surviving across every
 * agent card the user ever opens.
 */
export function AgentSessionSheet({
  agentId,
  agentLabel,
  open,
  onOpenChange,
}: AgentSessionSheetProps) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="flex w-full flex-col gap-4 sm:max-w-xl">
        <SheetHeader>
          <SheetTitle>{agentLabel}</SheetTitle>
          <SheetDescription>
            Prove the agent works, or administer it — not a chat product.
          </SheetDescription>
        </SheetHeader>
        {open && <AgentSessionBody agentId={agentId} />}
      </SheetContent>
    </Sheet>
  );
}

function AgentSessionBody({ agentId }: { agentId: string }) {
  const { sessionId, blocks, sending, ended, error, sendPrompt, answerPermission } =
    useAgentSession(agentId);
  const [draft, setDraft] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `blocks` is intentional — it's the trigger to re-scroll on every new transcript entry, not a value read inside the effect.
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [blocks]);

  const disabled = !sessionId || sending || ended;

  const submit = () => {
    const text = draft.trim();
    if (!text || disabled) return;
    setDraft("");
    void sendPrompt(text);
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <div
        ref={scrollRef}
        className="min-h-0 flex-1 overflow-y-auto rounded-md border border-border p-3"
      >
        {!sessionId && !error && (
          <p className="text-sm text-muted-foreground">Starting a session…</p>
        )}
        <AgentSessionTranscript blocks={blocks} onAnswerPermission={answerPermission} />
      </div>
      {error && <p className="text-sm text-destructive">{error}</p>}
      <div className="flex items-center gap-2">
        <Input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              submit();
            }
          }}
          placeholder={ended ? "This session has ended." : "Type a message…"}
          disabled={disabled}
        />
        <Button onClick={submit} disabled={disabled || draft.trim().length === 0}>
          {sending ? "Sending…" : "Send"}
        </Button>
      </div>
    </div>
  );
}
