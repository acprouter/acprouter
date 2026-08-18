/**
 * The consumer-facing half of task #14's proxy (spec §5.3 point 1 / §5.4):
 * the Router plays ACP AGENT toward an external consumer (Zed, Busabase, a
 * script) exactly the way Buda's own ACP agent implementation plays it
 * toward ITS consumers — same SDK shape (`acp.agent()` + `AcpServer`),
 * copied per spec §5.3's own citation
 * rather than re-derived. The one real difference from Buda's file, and the
 * whole point of this task: Buda's handlers translate ACP calls into ITS OWN
 * backend (`chat-service.ts`) because Buda has no other agent runtime to
 * defer to. This Router already has one — `sessions-logic.ts`'s
 * `startAgentSession`/`promptAgentSession`/`endAgentSession`, already
 * agent-kind-agnostic across `bridged` and `remote-acp` (task #13) — so every
 * handler below is a thin translation onto THOSE, never a second
 * connection-resolution or relay implementation.
 *
 * ## The relay generalization, and why it needed almost none
 *
 * The task brief expected a change inside `session-relay-registry.ts` to let
 * a live ACP connection "attach as a watcher" alongside the dashboard's
 * pull-based `EventQueue`. Investigating that file found a smaller fix:
 * `promptAgentSession`'s `AsyncGenerator<AgentSessionStreamEventVO>` is
 * ALREADY consumer-agnostic — the dashboard's oRPC `sessions.prompt`
 * procedure is just one `for await` reader of it (`router.ts`). This file is
 * the SECOND reader, translating the same wire-shaped events into real
 * outbound ACP calls on `ctx.client` instead of an SSE chunk. No new sink
 * type, no dual-queue abstraction — `watchSession`/`stopWatchingSession`
 * inside `promptAgentSession` are exercised completely unmodified.
 *
 * The one genuine gap: `permission_request` events are, for the dashboard,
 * purely informational (display a card; the ANSWER arrives later via a
 * separate `sessions.answerPermission` oRPC call hitting
 * `answerSessionPermission`). An external consumer instead answers a
 * forwarded `session/request_permission` INLINE, as the response to its own
 * real ACP request — and that response can legitimately be `{outcome:
 * "cancelled"}`, which `answerSessionPermission` had no way to express (it
 * only ever resolved `"selected"`). That is the one real generalization this
 * task made: `session-relay-registry.ts#resolveSessionPermission` widens the
 * resolution function to accept a full `acp.RequestPermissionOutcome`,
 * with `answerSessionPermission` kept as a `"selected"`-only wrapper for the
 * dashboard's existing call site. Same timer, same `pendingPermission` map,
 * same "never falls back to auto-allow" contract — untouched.
 */

import type { AgentSessionStreamEventVO } from "@acprouter/contract";
import * as acp from "@agentclientprotocol/sdk";
import type { Database } from "../../../db";
import { validateConsumerApiKey } from "./consumer-api-keys-logic";
import { resolveSessionPermission } from "./session-relay-registry";
import { endAgentSession, promptAgentSession, startAgentSession } from "./sessions-logic";

export interface ConsumerAcpIdentity {
  agentId: string;
}

/**
 * Resolves the identity for an inbound consumer ACP WebSocket upgrade —
 * mirrors Buda's own ACP auth resolution shape (bearer token +
 * `?agentId=`), but the credential itself is this Router's own minted
 * consumer API key (task #14), not a Buda `sk_...` personal key: OSS ships
 * with no accounts (spec §8.1), so there is no user identity to resolve here
 * at all — only "does this bearer value name a real, non-revoked key for
 * exactly this agent."
 *
 * Deliberately async and NOT awaited by the route (`route.ts` kicks this off
 * unawaited, same as Buda's `resolveAcpAuth` and `machine-bridge-connection
 * .ts`'s `dbPromise` pattern) — see this module's own doc comment and the
 * route file for the full same-tick reasoning this reprises rather than
 * re-derives.
 */
export async function resolveConsumerAcpAuth(
  dbPromise: Promise<Database>,
  request: Request,
): Promise<ConsumerAcpIdentity | null> {
  const authHeader = request.headers.get("authorization");
  const bearerToken = authHeader?.startsWith("Bearer ") ? authHeader.slice(7).trim() : null;
  const agentId = new URL(request.url).searchParams.get("agentId")?.trim();
  if (!agentId) return null;

  const db = await dbPromise;
  const valid = await validateConsumerApiKey(db, agentId, bearerToken);
  if (!valid) return null;

  return { agentId };
}

/** Real ACP `ContentBlock[]` → the plain text `promptAgentSession` takes — same reduction Buda's `contentBlocksToPromptText` performs, for the same reason: `sessions-logic.ts`'s `session/prompt` call takes a single `text` field (task #11's prompt-box shape), not a content-block array, and image/audio/resource blocks are not advertised in `promptCapabilities` below, so a well-behaved client won't send them. */
function contentBlocksToPromptText(blocks: readonly acp.ContentBlock[]): string {
  const lines: string[] = [];
  for (const block of blocks) {
    if (block.type === "text") {
      lines.push(block.text);
    } else if (block.type === "resource_link") {
      lines.push(`[${block.name}](${block.uri})`);
    }
  }
  return lines.join("\n");
}

/**
 * Forwards one `permission_request` event to the consumer's own ACP client
 * as a real `session/request_permission` REQUEST, then resolves the SAME
 * pending permission (blocking whichever underlying `bridged`/`remote-acp`
 * connection is waiting on it) with whatever real outcome the consumer gave.
 * Deliberately fire-and-forget from the caller's point of view (never
 * awaited inside the `for await` loop below) — the underlying agent is
 * already blocked on this same promise, so nothing else will produce another
 * event for this session until it resolves one way or another, and NOT
 * awaiting here means the loop stays free to observe `session_ended` if the
 * shared timeout fires first (`resolveSessionPermission` no-ops on a
 * already-resolved/timed-out permission — see its own doc comment).
 *
 * A consumer connection that errors or drops mid-request resolves
 * `cancelled` rather than leaving the underlying agent's tool call hanging
 * until the 5-minute timeout — same "never silently hang" posture as every
 * other error path in this domain, just triggered sooner than the shared
 * backstop.
 */
function relayPermissionRequestToConsumer(
  dbPromise: Promise<Database>,
  client: acp.AgentContext,
  sessionId: string,
  event: Extract<AgentSessionStreamEventVO, { type: "permission_request" }>,
): void {
  void client
    .request(acp.methods.client.session.requestPermission, {
      sessionId,
      toolCall: event.toolCall,
      options: event.options,
    })
    .then((response) => {
      resolveSessionPermission(dbPromise, sessionId, response.outcome);
    })
    .catch(() => {
      resolveSessionPermission(dbPromise, sessionId, { outcome: "cancelled" });
    });
}

/**
 * Builds the ACP `AgentApp` for one consumer WebSocket connection. Called
 * once per connection from `apps/acprouter/src/app/api/acp/route.ts`'s
 * `UPGRADE` handler, with `identityPromise` still unresolved — see that
 * file and `resolveConsumerAcpAuth`'s doc comment for why: the SDK must
 * already be listening before any DB lookup is awaited, or the consumer's
 * first `initialize` message can be silently dropped (the exact bug class
 * this Router's own `/api/acp` route documents hitting and fixing). Every
 * handler below awaits `identityPromise` first — by the time any of them
 * run, `AcpServer...accept()` has already wired the stream.
 */
export function createConsumerAcpAgentApp(
  dbPromise: Promise<Database>,
  identityPromise: Promise<ConsumerAcpIdentity | null>,
): acp.AgentApp {
  async function requireIdentity(): Promise<ConsumerAcpIdentity> {
    const identity = await identityPromise;
    if (!identity) {
      throw new Error(
        "Unauthorized: connect with `Authorization: Bearer <consumer API key>` and " +
          "`?agentId=<id>` naming the agent that key was minted for (Agents page → " +
          "Copy connection info).",
      );
    }
    return identity;
  }

  return acp
    .agent({ name: "acprouter" })
    .onRequest(acp.methods.agent.initialize, async () => {
      await requireIdentity();
      // Honest capabilities only — this Router has no `session/load` path
      // for an external consumer (only the dashboard's `sessions.history`
      // read-back exists, a distinct oRPC procedure, not ACP's
      // `session/load`), and no image/audio/embedded-context handling
      // anywhere in `contentBlocksToPromptText` above.
      return {
        protocolVersion: acp.PROTOCOL_VERSION,
        agentCapabilities: {
          loadSession: false,
          promptCapabilities: { image: false, audio: false, embeddedContext: false },
        },
      };
    })
    .onRequest(acp.methods.agent.session.new, async () => {
      const identity = await requireIdentity();
      const db = await dbPromise;
      const { sessionId } = await startAgentSession(db, identity.agentId);
      return { sessionId };
    })
    .onRequest(acp.methods.agent.session.prompt, async (ctx) => {
      const identity = await requireIdentity();
      const db = await dbPromise;
      const text = contentBlocksToPromptText(ctx.params.prompt);

      let stopReason: acp.StopReason = "end_turn";
      for await (const event of promptAgentSession(db, {
        agentId: identity.agentId,
        sessionId: ctx.params.sessionId,
        text,
      })) {
        switch (event.type) {
          case "session_update":
            await ctx.client.notify(acp.methods.client.session.update, {
              sessionId: ctx.params.sessionId,
              update: event.update,
            });
            break;
          case "permission_request":
            relayPermissionRequestToConsumer(dbPromise, ctx.client, ctx.params.sessionId, event);
            break;
          case "permission_resolved":
            // No ACP-native notification for this — it is purely dashboard
            // display; the consumer already knows its own answer.
            break;
          case "turn_ended":
            stopReason = event.stopReason;
            break;
          case "session_ended":
            throw new Error(event.reason);
          default: {
            const exhaustive: never = event;
            throw new Error(`unhandled session event: ${JSON.stringify(exhaustive)}`);
          }
        }
      }
      return { stopReason };
    })
    .onNotification(acp.methods.agent.session.cancel, async (ctx) => {
      const identity = await requireIdentity();
      const db = await dbPromise;
      await endAgentSession(db, { agentId: identity.agentId, sessionId: ctx.params.sessionId });
    });
}
