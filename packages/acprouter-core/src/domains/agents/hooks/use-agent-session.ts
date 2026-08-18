"use client";

import type { AgentSessionStreamEventVO } from "@acprouter/contract";
import { useCallback, useEffect, useRef, useState } from "react";
import { useAcprouterOrpc } from "../client";

export interface AgentMessageBlock {
  kind: "message";
  id: string;
  role: "user" | "agent";
  /** Rendered distinctly from a real reply — this is the agent's chain-of-thought (`agent_thought_chunk`), not its answer. */
  variant: "message" | "thought";
  text: string;
}

export interface AgentToolCallBlock {
  kind: "tool_call";
  id: string;
  title: string;
  toolKind: string | null;
  status: "pending" | "in_progress" | "completed" | "failed";
}

export interface AgentPermissionOption {
  optionId: string;
  name: string;
  kind: string;
}

export interface AgentPermissionBlock {
  kind: "permission";
  id: string;
  title: string;
  options: AgentPermissionOption[];
  timeoutAt: string;
  resolution: "pending" | "answering" | { optionId: string };
}

export interface AgentEndedBlock {
  kind: "ended";
  id: string;
  reason: string;
}

export type AgentTranscriptBlock =
  | AgentMessageBlock
  | AgentToolCallBlock
  | AgentPermissionBlock
  | AgentEndedBlock;

function textFromContent(content: { type: string; text?: string }): string | null {
  return content.type === "text" && typeof content.text === "string" ? content.text : null;
}

/**
 * Drives one prompt-box conversation (task #11) against a single connected
 * agent — `bridged` or `remote-acp` (task #13); this hook only ever talks to
 * the `sessions.*` oRPC procedures, never to bridge/connection internals, so
 * it needed no changes to support the second kind. One `session/new` for
 * the component's lifetime, reused
 * across every `sendPrompt` call via `session/prompt` — exactly the ACP
 * client shape spec §9 Phase 1 point 4 asks for, "not a chat product," just
 * the smallest real client that proves the agent works.
 */
export function useAgentSession(agentId: string) {
  const orpc = useAcprouterOrpc();
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [blocks, setBlocks] = useState<AgentTranscriptBlock[]>([]);
  const [sending, setSending] = useState(false);
  const [ended, setEnded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // AsyncIteratorObject<AgentSessionStreamEventVO> — typed loosely because
  // oRPC's inferred client return type for an `eventIterator` output isn't
  // exported as a standalone name; only its `.return()` cleanup method is
  // used below, which every async iterator exposes.
  const activeIteratorRef = useRef<{ return?: () => unknown } | null>(null);
  // These refs exist because of a real bug real e2e verification caught:
  // `sessions.start` always spawns a real agent process server-side. React
  // 18 StrictMode (dev only) mounts this effect, cleans it up, and mounts it
  // again — synchronously, same tick — specifically to surface non-
  // idempotent side effects like this one. Without `startedForAgentIdRef`,
  // that replay fired TWO real `session/new` calls (confirmed against the
  // real Router: two real `claude-agent-acp` child processes spawned for one
  // sheet open). The guard alone isn't enough, though: StrictMode's
  // SYNTHETIC first cleanup would otherwise mark the still-in-flight
  // `start()` call `cancelled` before it resolves, silently discarding the
  // one real session that DOES end up created — `cancelledRef` is reset on
  // every effect invocation (not just the first) so whichever invocation is
  // still mounted when the real request resolves is the one that accepts it.
  const startedForAgentIdRef = useRef<string | null>(null);
  const cancelledRef = useRef(false);
  const sessionIdRef = useRef<string | null>(null);

  useEffect(() => {
    cancelledRef.current = false;
    if (startedForAgentIdRef.current !== agentId) {
      startedForAgentIdRef.current = agentId;
      orpc.agents.sessions
        .start({ agentId })
        .then((result) => {
          sessionIdRef.current = result.sessionId;
          if (!cancelledRef.current) setSessionId(result.sessionId);
        })
        .catch((err: unknown) => {
          if (!cancelledRef.current) {
            setError(err instanceof Error ? err.message : "Could not start a session.");
          }
        });
    } else if (sessionIdRef.current) {
      // The real `start()` call (from an earlier, StrictMode-replayed
      // invocation) already resolved by the time this invocation ran —
      // keep state in sync rather than leaving it stuck on "Starting…".
      setSessionId(sessionIdRef.current);
    }
    return () => {
      cancelledRef.current = true;
      activeIteratorRef.current?.return?.();
      // Best-effort, fire-and-forget — a conversation nobody ever prompted
      // still gets its spawned process cancelled instead of orphaned. If
      // `start()` hasn't resolved yet (closed within the same tick it was
      // opened), there's nothing to end yet; nothing else will do it later.
      if (sessionIdRef.current) {
        void orpc.agents.sessions
          .end({ agentId, sessionId: sessionIdRef.current })
          .catch(() => undefined);
      }
    };
    // agentId is the whole identity of this session — a change means a new conversation, not a re-fetch of the same one.
  }, [agentId, orpc]);

  const applyEvent = useCallback((event: AgentSessionStreamEventVO) => {
    setBlocks((prev) => {
      switch (event.type) {
        case "session_update": {
          const update = event.update;
          if (
            update.sessionUpdate === "agent_message_chunk" ||
            update.sessionUpdate === "agent_thought_chunk"
          ) {
            const text = textFromContent(update.content);
            if (text === null) return prev;
            const variant = update.sessionUpdate === "agent_thought_chunk" ? "thought" : "message";
            const last = prev[prev.length - 1];
            if (last?.kind === "message" && last.role === "agent" && last.variant === variant) {
              const merged: AgentMessageBlock = { ...last, text: last.text + text };
              return [...prev.slice(0, -1), merged];
            }
            const block: AgentMessageBlock = {
              kind: "message",
              id: `agent-${prev.length}-${Date.now()}`,
              role: "agent",
              variant,
              text,
            };
            return [...prev, block];
          }
          if (update.sessionUpdate === "tool_call") {
            const block: AgentToolCallBlock = {
              kind: "tool_call",
              id: update.toolCallId,
              title: update.title,
              toolKind: update.kind ?? null,
              status: update.status ?? "pending",
            };
            return [...prev, block];
          }
          if (update.sessionUpdate === "tool_call_update") {
            const index = prev.findIndex(
              (b) => b.kind === "tool_call" && b.id === update.toolCallId,
            );
            if (index === -1) {
              // An update for a tool call this box never saw the creation of
              // (opened mid-turn) — render what we have rather than dropping it.
              const block: AgentToolCallBlock = {
                kind: "tool_call",
                id: update.toolCallId,
                title: update.title ?? update.toolCallId,
                toolKind: update.kind ?? null,
                status: update.status ?? "pending",
              };
              return [...prev, block];
            }
            const existing = prev[index] as AgentToolCallBlock;
            const merged: AgentToolCallBlock = {
              ...existing,
              title: update.title ?? existing.title,
              toolKind: update.kind ?? existing.toolKind,
              status: update.status ?? existing.status,
            };
            return [...prev.slice(0, index), merged, ...prev.slice(index + 1)];
          }
          // plan/available_commands_update/etc. — no acceptance criterion
          // asks for these in the MVP prompt box; ignored rather than
          // rendered as unreadable raw JSON.
          return prev;
        }
        case "permission_request": {
          const block: AgentPermissionBlock = {
            kind: "permission",
            id: event.toolCall.toolCallId,
            title: event.toolCall.title ?? "runs a tool call",
            options: event.options.map((option) => ({
              optionId: option.optionId,
              name: option.name,
              kind: option.kind,
            })),
            timeoutAt: event.timeoutAt,
            resolution: "pending",
          };
          return [...prev, block];
        }
        case "permission_resolved": {
          // Resolve the OLDEST still-unresolved permission block — ACP does
          // not overlap requests within a session, so there is at most one.
          // Matches BOTH "pending" and "answering": a real bug real e2e
          // verification caught — `answerPermission` optimistically flips a
          // block to "answering" the instant the user clicks (so the button
          // disables immediately, before the round trip completes), and this
          // reducer used to only match "pending", silently dropping the real
          // `permission_resolved` event that arrives moments later because by
          // then the block was already "answering," not "pending."
          const target = prev.findIndex(
            (b) =>
              b.kind === "permission" &&
              (b.resolution === "pending" || b.resolution === "answering"),
          );
          if (target === -1) return prev;
          const existing = prev[target] as AgentPermissionBlock;
          const merged: AgentPermissionBlock = {
            ...existing,
            resolution: { optionId: event.optionId },
          };
          return [...prev.slice(0, target), merged, ...prev.slice(target + 1)];
        }
        case "turn_ended":
        case "session_ended":
          return prev;
        default:
          return prev;
      }
    });

    if (event.type === "session_ended") {
      setEnded(true);
      setBlocks((prev) => [
        ...prev,
        { kind: "ended", id: `ended-${Date.now()}`, reason: event.reason },
      ]);
    }
  }, []);

  const sendPrompt = useCallback(
    async (text: string) => {
      if (!sessionId || sending || ended) return;
      setError(null);
      setSending(true);
      setBlocks((prev) => [
        ...prev,
        { kind: "message", id: `user-${Date.now()}`, role: "user", variant: "message", text },
      ]);
      try {
        const iterator = await orpc.agents.sessions.prompt({ agentId, sessionId, text });
        activeIteratorRef.current = iterator;
        for await (const event of iterator) {
          applyEvent(event);
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : "The prompt failed.");
      } finally {
        activeIteratorRef.current = null;
        setSending(false);
      }
    },
    [agentId, sessionId, sending, ended, applyEvent, orpc],
  );

  const answerPermission = useCallback(
    async (block: AgentPermissionBlock, optionId: string) => {
      if (!sessionId || block.resolution !== "pending") return;
      setBlocks((prev) =>
        prev.map((b) =>
          b.kind === "permission" && b.id === block.id ? { ...b, resolution: "answering" } : b,
        ),
      );
      try {
        const result = await orpc.agents.sessions.answerPermission({ sessionId, optionId });
        if (!result.answered) {
          // Too late — the 5-minute timeout already fired server-side and
          // resolved `cancelled` on its own; the `session_ended` terminal
          // event is what actually explains this to the user, not this click.
          setBlocks((prev) =>
            prev.map((b) =>
              b.kind === "permission" && b.id === block.id ? { ...b, resolution: "pending" } : b,
            ),
          );
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : "Could not send that answer.");
        setBlocks((prev) =>
          prev.map((b) =>
            b.kind === "permission" && b.id === block.id ? { ...b, resolution: "pending" } : b,
          ),
        );
      }
    },
    [sessionId, orpc],
  );

  return {
    sessionId,
    blocks,
    sending,
    ended,
    error,
    sendPrompt,
    answerPermission,
  };
}
