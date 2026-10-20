import type { AcpUiEvent } from "@acp-ui/core/reduce";
import type { AcpSessionPort } from "@acp-ui/core/session";
import type { AgentSessionStreamEventVO } from "@acprouter/contract";
import type { AcprouterAgentsClient } from "../client";

/**
 * Builds the Router's `AcpSessionPort` implementation — split out of
 * `use-agent-session.ts` so the adoption branch (Decision 3, design.md) can
 * be unit-tested with a plain mocked `orpc` object, no React/DOM involved.
 *
 * `adoptedSessionId`, when present, makes `start` resolve to it directly
 * instead of calling `orpc.agents.sessions.start(...)` — mirroring
 * `busabase-core`'s existing `start: async () => sessionId ?? ""` shape.
 * This is the ONLY behavioral branch; every other method is identical
 * regardless of how the session id was obtained, since they all operate
 * purely in terms of a `sessionId` string already in hand.
 */
export interface AgentSessionPortDeps {
  orpc: AcprouterAgentsClient;
  agentId: string;
  adoptedSessionId?: string | null;
  /** Mirrors `lastSessionByAgent` in `use-agent-session.ts` — module-level there, injected here for testability. */
  rememberSession: (agentId: string, sessionId: string) => void;
  /** The previous session id captured at mount, before `start` overwrites it — see `previousSessionIdRef` in `use-agent-session.ts`. */
  getPreviousSessionId: () => string | null;
  outstandingPermissionRef: { current: string | null };
  sinkRef: { current: ((event: AcpUiEvent) => void) | null };
  activeIteratorRef: { current: { return?: () => unknown } | null };
  /**
   * Fires the moment `start()` actually resolves with `adoptedSessionId` —
   * the real, observable signal that this sheet's session port started
   * consuming the handed-off session (Final Review Clarifications: "no
   * claim that an `onConnected` call alone proves a sheet mounted"). Never
   * called on the non-adoption path (manual-Open always starts its own
   * fresh session, no lease to transfer). Omitted by callers that don't
   * track a lease.
   */
  onAdopted?: (agentId: string, sessionId: string) => void;
}

function translateEvent(
  event: AgentSessionStreamEventVO,
  outstandingPermissionRef: { current: string | null },
  opts: { scrollback?: boolean } = {},
): AcpUiEvent | null {
  switch (event.type) {
    case "session_update":
      return { type: "session_update", update: event.update };
    case "permission_request": {
      const requestId = event.toolCall.toolCallId;
      outstandingPermissionRef.current = requestId;
      return {
        type: "permission_request",
        requestId,
        title: event.toolCall.title ?? "runs a tool call",
        options: event.options.map((option) => ({
          optionId: option.optionId,
          name: option.name,
          kind: option.kind,
        })),
        timeoutAt: event.timeoutAt,
      };
    }
    case "permission_resolved": {
      const requestId = outstandingPermissionRef.current;
      if (!requestId) return null;
      outstandingPermissionRef.current = null;
      return { type: "permission_resolved", requestId, optionId: event.optionId };
    }
    case "session_ended":
      // A previous session's terminal event must NOT carry `ended` — it
      // would mark the NEW session ended and lock the input over a
      // conversation that is actually alive.
      return opts.scrollback
        ? { type: "note", text: `Session ended — ${event.reason}` }
        : { type: "note", text: `Session ended — ${event.reason}`, ended: true };
    // Never carries `ended` — a note explains what happened to an
    // attachment, it does not stop the conversation.
    case "note":
      return { type: "note", text: event.text };
    // ACP has no session-lifecycle notification of its own; `turn_ended`
    // only says this turn stopped, which `sending` already conveys.
    case "turn_ended":
      return null;
    default:
      return null;
  }
}

export function createAgentSessionPort(deps: AgentSessionPortDeps): AcpSessionPort {
  const {
    orpc,
    agentId,
    adoptedSessionId,
    rememberSession,
    getPreviousSessionId,
    outstandingPermissionRef,
    sinkRef,
    activeIteratorRef,
    onAdopted,
  } = deps;

  const translate = (event: AgentSessionStreamEventVO, opts: { scrollback?: boolean } = {}) =>
    translateEvent(event, outstandingPermissionRef, opts);

  return {
    start: async () => {
      // Decision 3: adoption short-circuits the real `sessions.start` call
      // entirely — the dialog that owns this id already proved the session
      // is live (sessions-logic.ts#startAgentSession already resolved).
      if (adoptedSessionId) {
        rememberSession(agentId, adoptedSessionId);
        // This is the actual "the sheet adopted it" event — synchronous with
        // `start()` resolving, not inferred from `onConnected` having been
        // called earlier up the chain.
        onAdopted?.(agentId, adoptedSessionId);
        return adoptedSessionId;
      }
      const result = await orpc.agents.sessions.start({ agentId });
      rememberSession(agentId, result.sessionId);
      return result.sessionId;
    },

    history: async (sessionId) => {
      const previousId = getPreviousSessionId();
      const [scrollback, own] = await Promise.all([
        previousId && previousId !== sessionId
          ? orpc.agents.sessions.history({ sessionId: previousId })
          : Promise.resolve([]),
        orpc.agents.sessions.history({ sessionId }),
      ]);
      return [
        ...scrollback.map((event) => translate(event, { scrollback: true })),
        ...own.map((event) => translate(event)),
      ].filter((event): event is AcpUiEvent => event !== null);
    },

    subscribe: (_sessionId, onEvent) => {
      sinkRef.current = onEvent;
      return () => {
        sinkRef.current = null;
        activeIteratorRef.current?.return?.();
        activeIteratorRef.current = null;
      };
    },

    prompt: async (sessionId, text, attachments) => {
      const iterator = await orpc.agents.sessions.prompt({
        agentId,
        sessionId,
        text,
        ...(attachments && attachments.length > 0 ? { attachments: [...attachments] } : {}),
      });
      activeIteratorRef.current = iterator;
      try {
        for await (const event of iterator) {
          const translated = translate(event);
          if (translated) sinkRef.current?.(translated);
        }
      } finally {
        activeIteratorRef.current = null;
      }
    },

    answerPermission: async (sessionId, _block, optionId) => {
      const result = await orpc.agents.sessions.answerPermission({ sessionId, optionId });
      return result.answered;
    },

    end: (sessionId) => {
      // Fire-and-forget: a conversation nobody prompted still gets its spawned
      // process cancelled instead of orphaned.
      void orpc.agents.sessions.end({ agentId, sessionId }).catch(() => undefined);
    },

    cancel: async (sessionId) => {
      await orpc.agents.sessions.cancelTurn({ agentId, sessionId });
    },

    // The Router emits nothing for the user's own prompt, so the core appends
    // it — otherwise the user's words never appear.
    serverEchoesPrompt: false,
  };
}
