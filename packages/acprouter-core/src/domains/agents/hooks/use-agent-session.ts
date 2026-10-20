"use client";

import type { AcpUiEvent } from "@acp-ui/core/reduce";
import { useAcpSession } from "@acp-ui/core/session";
import { useMemo, useRef } from "react";
import { useAcprouterOrpc } from "../client";
import { createAgentSessionPort } from "./agent-session-port";

/**
 * The last session each agent's sheet drove, remembered across sheet
 * open/close within this page load.
 *
 * The sheet deliberately starts a fresh `session/new` per open (it is an
 * admin surface, not a chat product), which used to mean closing it threw the
 * conversation away — even though every event was persisted and
 * `sessions.history` existed. Remembering the previous session's id is the
 * missing link: on the next open, its transcript is folded in as scrollback
 * before the new session's live events. Module-level on purpose — the sheet
 * unmounts entirely on close, so component state cannot carry this.
 */
const lastSessionByAgent = new Map<string, string>();

/**
 * The Router's ACP transport, expressed as an `AcpSessionPort`.
 *
 * Everything about *how* events reach the browser stays here — the
 * `sessions.*` oRPC procedures, the per-prompt event iterator, the relay's
 * quirks. Everything about *what the conversation is* now lives in
 * `@acp-ui/core`, shared with busabase. This hook only ever talks to the
 * `sessions.*` procedures, never to bridge/connection internals, which is why
 * it supports `bridged` and `remote-acp` agents alike without knowing either.
 *
 * `adoptedSessionId` (design.md Decision 3): when supplied, `port.start`
 * resolves to it directly instead of calling `orpc.agents.sessions.start` —
 * the enrollment handoff (`AgentsPageClientBody`) already ran that call
 * inside `AddAgentDialog`'s coordinator, so this hook adopts the
 * already-live session rather than starting a second one. Omitted (or
 * `null`/`undefined`), this hook behaves exactly as it always has — the
 * manual-Open path (`RegisteredAgentsList`) is unaffected.
 *
 * `onAdopted` (Final Review Clarifications: explicit acknowledged
 * ownership): fires the instant `port.start()` resolves with
 * `adoptedSessionId` — the real signal that THIS sheet instance actually
 * started consuming the handed-off session, as opposed to merely having
 * been asked to render. The caller uses this to transfer a `SessionLease`
 * from "accepted" to "adopted".
 */
export function useAgentSession(
  agentId: string,
  adoptedSessionId?: string | null,
  onAdopted?: (agentId: string, sessionId: string) => void,
) {
  const orpc = useAcprouterOrpc();

  // The Router streams a turn as an async iterator returned by `prompt`, not as
  // a standing subscription, so the adapter bridges the two: `subscribe` parks
  // the sink, `prompt` pumps the iterator into it.
  const sinkRef = useRef<((event: AcpUiEvent) => void) | null>(null);
  const activeIteratorRef = useRef<{ return?: () => unknown } | null>(null);
  // `permission_resolved` carries only an `optionId` — the Router relies on ACP
  // never overlapping permission requests within a session, so "the outstanding
  // one" is unambiguous. The shared core keys permissions by id, so the adapter
  // is what remembers which id that was.
  const outstandingPermissionRef = useRef<string | null>(null);
  // Captured at mount, BEFORE `start` overwrites the map with the new session.
  const previousSessionIdRef = useRef<string | null>(lastSessionByAgent.get(agentId) ?? null);
  // Stable ref so a changing `onAdopted` identity across re-renders never
  // forces `port` to be rebuilt (which would restart the session) — mirrors
  // `onConnectedRef` in `add-agent-dialog.tsx`.
  const onAdoptedRef = useRef(onAdopted);
  onAdoptedRef.current = onAdopted;

  const port = useMemo(
    () =>
      createAgentSessionPort({
        orpc,
        agentId,
        adoptedSessionId,
        rememberSession: (id, sessionId) => lastSessionByAgent.set(id, sessionId),
        getPreviousSessionId: () => previousSessionIdRef.current,
        outstandingPermissionRef,
        sinkRef,
        activeIteratorRef,
        onAdopted: (id, sessionId) => onAdoptedRef.current?.(id, sessionId),
      }),
    [agentId, orpc, adoptedSessionId],
  );

  return useAcpSession(port, agentId);
}
