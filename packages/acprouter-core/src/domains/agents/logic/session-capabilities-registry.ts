import type { PromptCapabilities } from "@agentclientprotocol/sdk";

/**
 * What each live session's agent said it can accept in a prompt.
 *
 * Keyed per SESSION rather than per agent, because for a `bridged` machine
 * that is the only unit that is true: the CLI spawns a fresh agent per
 * `session/new`, chosen by that request's `registrySlug`, so one machine can
 * be running two different agents — with different capabilities — at the same
 * time. The `acprouter_agents` row cannot hold this; it describes the machine's
 * pinned agent, not whatever a given session actually spawned.
 *
 * Deliberately NOT persisted. Capabilities describe a running process, not
 * history: a session row outlives the process it names, and a stale row would
 * be worse than no answer at all, since `buildPromptContent` treats "no
 * answer" as "send everything" (the pre-negotiation behaviour) but treats a
 * present-and-wrong answer as authority to withhold a user's attachment.
 *
 * Same `globalThis`-caching reasoning as `remote-session-registry.ts`: Next.js
 * dev-mode module-graph re-evaluation would otherwise mint a second, empty map
 * that `startAgentSession` and `promptAgentSession` would disagree about.
 */

type GlobalWithSessionCapabilities = typeof globalThis & {
  __acprouterSessionCapabilities?: Map<string, PromptCapabilities>;
};

function getRegistry(): Map<string, PromptCapabilities> {
  const g = globalThis as GlobalWithSessionCapabilities;
  if (!g.__acprouterSessionCapabilities) {
    g.__acprouterSessionCapabilities = new Map();
  }
  return g.__acprouterSessionCapabilities;
}

/**
 * Called once `session/new` returns, with whatever the machine reported.
 *
 * `null` is stored as nothing at all rather than as an empty object: an old
 * CLI that never sends this must stay un-negotiated (send everything), which
 * is a different answer from an agent that explicitly advertised no optional
 * capabilities (`{}` — withhold everything but text).
 */
export function rememberSessionCapabilities(
  sessionId: string,
  capabilities: PromptCapabilities | null,
): void {
  if (!capabilities) return;
  getRegistry().set(sessionId, capabilities);
}

/** `null` when this session's agent never reported any — the caller must then send un-negotiated. */
export function getSessionCapabilities(sessionId: string): PromptCapabilities | null {
  return getRegistry().get(sessionId) ?? null;
}

/** Called when a session ends, so a long-lived Router process does not accumulate one entry per session forever. */
export function forgetSessionCapabilities(sessionId: string): void {
  getRegistry().delete(sessionId);
}
