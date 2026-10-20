"use client";

import { AcpComposer } from "@acp-ui/web/composer";
import { AcpSessionMeta } from "@acp-ui/web/session-meta";
import { AcpConversation } from "@acp-ui/web/transcript";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "kui/sheet";
import { useAgentSession } from "../hooks/use-agent-session";

interface AgentSessionSheetProps {
  agentId: string;
  agentLabel: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /**
   * When present, this sheet adopts an already-live session instead of
   * starting a new one (design.md Decision 3) — the enrollment handoff
   * (`AgentsPageClientBody`) already ran `sessions.start` inside
   * `AddAgentDialog`'s coordinator before this sheet ever mounted. Omitted
   * for every other caller (`RegisteredAgentsList`'s manual "Open"), which
   * starts its own fresh session exactly as before.
   */
  adoptedSessionId?: string | null;
  /**
   * Final Review Clarifications: fires the instant this sheet's own session
   * port actually starts consuming `adoptedSessionId` — the real "the sheet
   * adopted it" signal a caller holding a `SessionLease` needs to call
   * `lease.adopt()`. Never fired on the manual-Open (non-adoption) path.
   */
  onAdopted?: (agentId: string, sessionId: string) => void;
}

/**
 * The "prove the agent works / administer it" prompt box (spec §9 Phase 1
 * point 4, §1.1) — deliberately minimal: one text box, a transcript, tool
 * calls and permission requests as distinct cards. Mounted only while
 * `open`, so a fresh `useAgentSession` (and its `session/new`, unless
 * `adoptedSessionId` is supplied) is created each time the sheet opens
 * rather than one session surviving across every agent card the user ever
 * opens — but the conversation is no longer lost with it, since the
 * session's persisted history is replayed on open.
 *
 * The transcript AND the composer are `@acp-ui/web`, shared with busabase.
 * Auto-scroll comes from kui's stick-to-bottom `Conversation`, replacing the
 * manual `scrollTo` this component used to run on every block change.
 */
export function AgentSessionSheet({
  agentId,
  agentLabel,
  open,
  onOpenChange,
  adoptedSessionId,
  onAdopted,
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
        {open && (
          <AgentSessionBody
            agentId={agentId}
            adoptedSessionId={adoptedSessionId}
            onAdopted={onAdopted}
          />
        )}
      </SheetContent>
    </Sheet>
  );
}

function AgentSessionBody({
  agentId,
  adoptedSessionId,
  onAdopted,
}: {
  agentId: string;
  adoptedSessionId?: string | null;
  onAdopted?: (agentId: string, sessionId: string) => void;
}) {
  const {
    sessionId,
    blocks,
    sending,
    ended,
    error,
    title,
    usage,
    sendPrompt,
    answerPermission,
    cancel,
  } = useAgentSession(agentId, adoptedSessionId, onAdopted);

  const disabled = !sessionId || sending || ended;

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <AcpSessionMeta className="text-muted-foreground text-xs" title={title} usage={usage} />
      <div className="flex min-h-0 flex-1 flex-col rounded-md border border-border">
        {!sessionId && !error ? (
          <p className="p-3 text-sm text-muted-foreground">Starting a session…</p>
        ) : (
          <AcpConversation
            blocks={blocks}
            streaming={sending}
            onAnswerPermission={answerPermission}
            emptyTitle="Send a prompt to start."
            emptyDescription=""
          />
        )}
      </div>
      {error && <p className="text-sm text-destructive">{error}</p>}
      <AcpComposer
        disabled={disabled}
        onSend={(text, attachments) => void sendPrompt(text, attachments)}
        onStop={cancel}
        placeholder={ended ? "This session has ended." : "Type a message…"}
        sending={sending}
      />
    </div>
  );
}
