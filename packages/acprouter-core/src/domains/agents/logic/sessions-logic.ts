import type {
  AgentSessionStreamEventVO,
  AnswerAgentSessionPermissionOutput,
} from "@acprouter/contract";
import * as acp from "@agentclientprotocol/sdk";
import { ORPCError } from "@orpc/server";
import type WebSocket from "ws";
import type { Database } from "../../../db";
import type { AgentPO } from "../schema/agents";
import { streamFromWebSocket } from "./acp-ws-stream";
import { decryptAgentApiKey } from "./agent-credential-crypto";
import { getAgentById } from "./agents-logic";
import { getMachineBridge } from "./machine-bridge-registry";
import {
  dialRemoteAcpSocket,
  getAgentCredentialById,
  performAcpInitializeHandshake,
} from "./remote-agents-logic";
import {
  closeRemoteSessionConnection,
  getRemoteSessionConnection,
  registerRemoteSessionConnection,
} from "./remote-session-registry";
import { sweepAgentSessionEvents } from "./session-events-logic";
import {
  answerSessionPermission,
  DEFAULT_PERMISSION_TIMEOUT_MS,
  emitSessionTerminal,
  emitSessionUpdate,
  requestSessionPermission,
  stopWatchingSession,
  toStreamEventVO,
  watchSession,
} from "./session-relay-registry";
import {
  getSessionAgentId,
  insertActiveSession,
  markSessionActive,
  markSessionEnded,
} from "./session-status-logic";

/**
 * What both `bridged` and `remote-acp` agents boil down to, from
 * `sessions-logic.ts`'s point of view: an `agent` row plus a live
 * `acp.ClientConnection` to send `session/*` requests on. The TWO kinds
 * differ only in how that connection is obtained and how long it lives —
 * everything below this abstraction (the actual `session/new`/`prompt`/
 * `cancel` calls, the relay wiring) is unmodified from task #11.
 */
interface ResolvedAgentConnection {
  agent: AgentPO;
  connection: acp.ClientConnection;
}

/**
 * Resolves the connection to send a `session/new` on. `bridged` reuses the
 * machine's already-connected persistent bridge from
 * `machine-bridge-registry.ts` (unchanged since task #11 — one connection
 * serves every session on that machine). `remote-acp` (task #13) DIALS A
 * FRESH connection here, one per prompt-box conversation: Buda is one
 * stable, always-reachable server with none of a bridged machine's
 * NAT/sleep/reconnect problem (spec §11 point 6), so there is nothing for a
 * persistent-connection registry to buy here that a per-session dial
 * doesn't already give for free — see `remote-session-registry.ts`'s module
 * doc comment for the fuller reasoning.
 *
 * Returns two callbacks instead of eagerly registering anything, because
 * the `remote-acp` connection isn't findable by anything until
 * `session/new` actually returns a real `sessionId` — `startAgentSession`
 * calls exactly one of the two once it knows the outcome:
 *  - `onSessionCreated(sessionId)`: registers the connection in
 *    `remote-session-registry.ts` so `promptAgentSession`/`endAgentSession`
 *    (called later, in SEPARATE oRPC round trips) can find it again. No-op
 *    for `bridged` — nothing new to register; the bridge was already found.
 *  - `onSessionCreateFailed(error)`: tears down the connection this
 *    function just dialled, since nothing else will ever close a connection
 *    that never got a `sessionId` to be registered under. No-op for
 *    `bridged` — that connection is `machine-bridge-registry.ts`'s shared,
 *    persistent entry and must NEVER be torn down over one failed session.
 */
async function resolveConnectionForNewSession(
  db: Database,
  agentId: string,
): Promise<
  ResolvedAgentConnection & {
    onSessionCreated: (sessionId: string) => void;
    onSessionCreateFailed: (error: unknown) => void;
  }
> {
  const agent = await getAgentById(db, agentId);
  if (!agent) {
    throw new ORPCError("NOT_FOUND", { message: `No agent registered with id "${agentId}".` });
  }

  if (agent.kind === "remote-acp") {
    const { connection, socket } = await dialRemoteAcpConnectionForSession(db, agent);
    return {
      agent,
      connection,
      onSessionCreated: (sessionId) =>
        registerRemoteSessionConnection(sessionId, connection, socket),
      onSessionCreateFailed: (error) => {
        connection.close(error);
        socket.close();
      },
    };
  }

  if (!agent.machineId) {
    throw new ORPCError("NOT_IMPLEMENTED", {
      message: `"${agent.label}" is a ${agent.kind} agent — the prompt box only drives bridged and remote-acp agents right now.`,
    });
  }
  if (!agent.registrySlug) {
    throw new ORPCError("PRECONDITION_FAILED", {
      message: `"${agent.label}" has no registry slug on record — cannot start a session.`,
    });
  }
  const bridge = getMachineBridge(agent.machineId);
  if (!bridge) {
    throw new ORPCError("PRECONDITION_FAILED", {
      message: `"${agent.label}"'s machine has no live connection right now. Make sure the bridge is running and try again.`,
    });
  }
  return {
    agent,
    connection: bridge.connection,
    onSessionCreated: () => undefined,
    onSessionCreateFailed: () => undefined,
  };
}

/**
 * Resolves the connection for a session that ALREADY EXISTS — used by
 * `promptAgentSession`, `endAgentSession`. `bridged` looks up the same
 * persistent bridge every time (a session id carries no bridge-routing
 * information of its own; the agent's `machineId` does). `remote-acp` looks
 * up `remote-session-registry.ts` by `sessionId` directly — the only place
 * that per-session dial is ever findable again after `startAgentSession`
 * returned.
 */
async function resolveConnectionForExistingSession(
  db: Database,
  agentId: string,
  sessionId: string,
): Promise<ResolvedAgentConnection> {
  const agent = await getAgentById(db, agentId);
  if (!agent) {
    throw new ORPCError("NOT_FOUND", { message: `No agent registered with id "${agentId}".` });
  }

  if (agent.kind === "remote-acp") {
    const entry = getRemoteSessionConnection(sessionId);
    if (!entry) {
      throw new ORPCError("PRECONDITION_FAILED", {
        message: `"${agent.label}" has no live connection for session "${sessionId}" — it may have already ended.`,
      });
    }
    return { agent, connection: entry.connection };
  }

  if (!agent.machineId) {
    throw new ORPCError("NOT_IMPLEMENTED", {
      message: `"${agent.label}" is a ${agent.kind} agent — the prompt box only drives bridged and remote-acp agents right now.`,
    });
  }
  const bridge = getMachineBridge(agent.machineId);
  if (!bridge) {
    throw new ORPCError("PRECONDITION_FAILED", {
      message: `"${agent.label}"'s machine has no live connection right now. Make sure the bridge is running and try again.`,
    });
  }
  return { agent, connection: bridge.connection };
}

/**
 * Dials a fresh outbound connection to a `remote-acp` agent's endpoint and
 * wires the SAME session-relay handlers `machine-bridge-connection.ts`
 * wires on its (inbound) connection: `session/update` → `emitSessionUpdate`,
 * `session/request_permission` → `requestSessionPermission`. Deliberately
 * NOT extracted into one shared "build a wired ACP client connection"
 * helper used by both this file and `machine-bridge-connection.ts` — the
 * two builders differ in exactly the parts that matter (this one has no
 * machine registry, no keepalive, no close-code scheme; that one has no
 * per-session dial) and factoring out just the identical middle
 * (`.onNotification(...).onRequest(...)`) would leave two call sites each
 * still doing their own dial/connect/initialize around a shared fragment
 * that's shorter than the two doc comments explaining why it's shared —
 * this repo's existing files lean toward NOT abstracting at that grain (see
 * e.g. `remote-agents-logic.ts`'s own doc comment on a similar call).
 *
 * Wires `session/request_permission` even though Buda — today's only
 * `remote-acp` backend — forces `yolo: true` and never sends it (spec
 * §5.5a/§11 point 6): this is a structural property of ANY `remote-acp`
 * agent, not a Buda-specific one, and the abstraction shouldn't special-case
 * away a real ACP method just because the one live backend never exercises
 * it. If it never fires, `requestSessionPermission`'s own 5-minute timeout
 * still bounds it exactly like the bridged path.
 */
async function dialRemoteAcpConnectionForSession(
  db: Database,
  agent: AgentPO,
): Promise<{ connection: acp.ClientConnection; socket: WebSocket }> {
  if (!agent.endpoint || !agent.credentialId) {
    throw new ORPCError("PRECONDITION_FAILED", {
      message: `"${agent.label}" has no endpoint/credential on record — cannot start a session.`,
    });
  }
  const credential = await getAgentCredentialById(db, agent.credentialId);
  if (!credential) {
    throw new ORPCError("PRECONDITION_FAILED", {
      message: `"${agent.label}"'s stored credential is missing — reconnect it from the Agents page.`,
    });
  }
  const apiKey = decryptAgentApiKey(credential.encryptedPayload);

  const socket = await dialRemoteAcpSocket(agent.endpoint, apiKey);
  const dbPromise = Promise.resolve(db);
  const connection = acp
    .client({ name: "acprouter" })
    .onNotification(acp.methods.client.session.update, (ctx) => {
      emitSessionUpdate(dbPromise, ctx.params.sessionId, ctx.params.update);
    })
    .onRequest(acp.methods.client.session.requestPermission, (ctx) =>
      requestSessionPermission(
        dbPromise,
        ctx.params.sessionId,
        ctx.params.toolCall,
        ctx.params.options,
        {
          timeoutMs: DEFAULT_PERMISSION_TIMEOUT_MS,
        },
      ).then((outcome) => ({ outcome })),
    )
    .connect(streamFromWebSocket(socket));

  await performAcpInitializeHandshake(connection, socket, agent.endpoint);
  return { connection, socket };
}

/**
 * One `session/new` per prompt-box conversation (spec §9 Phase 1 point 4) —
 * called once when the user opens the box, reused across every `prompt`
 * call in that conversation via `session/prompt`, exactly like a real ACP
 * client. `cwd` is a formality here: `bridge-agent.ts` (task #8) never reads
 * it, always using the machine's own locally-configured directory —
 * enforced there, not here, so this is not a second copy of that invariant.
 * For `remote-acp` (task #13), `agent.cwd` is always `null` and Buda ignores
 * `cwd` outright (spec §5.5a), so `agent.cwd ?? "/"` sending `"/"` is inert
 * rather than special-cased away — same "don't special-case what the
 * backend already ignores" posture the task brief asked for.
 *
 * Task #12: also inserts the durable `acprouter_agent_sessions` row
 * (`status: "active"`) and opportunistically runs the retention sweep.
 * Neither is allowed to break a real ACP session that DID get created —
 * both are best-effort, logged-not-thrown, same posture as
 * `machine-bridge-connection.ts`'s `reportBridgedAgentFromInitialize`.
 * A dedicated background scheduler/cron job was considered for the sweep and
 * rejected: standing up real, separate infrastructure (its own runtime
 * process) would be disproportionate to pull into a deliberately lean,
 * no-login, single-process, self-hostable OSS app (spec §8.1) for a sweep
 * this cheap. "Every new session" is a fine cadence for a self-hosted,
 * single-operator tool — frequent enough to bound growth, and a no-op read
 * (`WHERE created_at < cutoff` against an already-indexed column) the rest
 * of the time.
 */
export async function startAgentSession(
  db: Database,
  agentId: string,
): Promise<{ sessionId: string }> {
  const resolved = await resolveConnectionForNewSession(db, agentId);
  const { agent, connection } = resolved;

  let response: acp.NewSessionResponse;
  try {
    response = await connection.agent.request(acp.methods.agent.session.new, {
      cwd: agent.cwd ?? "/",
      mcpServers: [],
      _meta: { registrySlug: agent.registrySlug },
    });
  } catch (error) {
    resolved.onSessionCreateFailed(error);
    throw error;
  }
  resolved.onSessionCreated(response.sessionId);

  try {
    await insertActiveSession(db, { id: response.sessionId, agentId: agent.id, consumerId: null });
  } catch (error) {
    console.error(
      `[acprouter] failed to persist session row sessionId=${response.sessionId}: ${String(error)}`,
    );
  }
  void sweepAgentSessionEvents(db).catch((error: unknown) => {
    console.error(`[acprouter] retention sweep failed: ${String(error)}`);
  });

  return { sessionId: response.sessionId };
}

/**
 * The streaming leg (task #11, acceptance criterion 1): sends a real
 * `session/prompt` to the machine's spawned agent through the live bridge
 * and, IN PARALLEL, yields whatever `session-relay-registry.ts` routes to
 * this specific session — `session/update` chunks, an inline permission
 * card, and finally a `turn_ended`/`session_ended` terminal event that ends
 * this generator.
 *
 * `watchSession` MUST be called before the prompt request is sent (both
 * happen synchronously in this tick) — an update notification that arrives
 * before a queue is attached is dropped, not buffered, so attaching late
 * would lose the start of the reply. The prompt request itself is
 * deliberately NOT awaited before the `for await` loop starts: it settles
 * (or rejects) independently, on its own promise chain, and its outcome is
 * what produces the terminal event that ends the loop.
 *
 * Task #13: `resolveConnectionForExistingSession` makes this function
 * itself transport-agnostic — it has no idea whether `connection` is a
 * shared bridged-machine connection or a per-session `remote-acp` dial, and
 * doesn't need to.
 */
export async function* promptAgentSession(
  db: Database,
  input: { agentId: string; sessionId: string; text: string },
): AsyncGenerator<AgentSessionStreamEventVO, void, void> {
  const { connection } = await resolveConnectionForExistingSession(
    db,
    input.agentId,
    input.sessionId,
  );

  // Best-effort, fire-and-forget (task #12): re-arms `"active"` for a
  // session that read `"idle"` after a previous turn. Never awaited — must
  // not delay the synchronous `watchSession` → prompt-request pairing below.
  void markSessionActive(db, input.sessionId).catch((error: unknown) => {
    console.error(
      `[acprouter] failed to mark session active sessionId=${input.sessionId}: ${String(error)}`,
    );
  });

  const events = watchSession(input.sessionId);

  void connection.agent
    .request(acp.methods.agent.session.prompt, {
      sessionId: input.sessionId,
      prompt: [{ type: "text", text: input.text }],
    })
    .then((response) => {
      emitSessionTerminal(Promise.resolve(db), input.sessionId, {
        type: "turn_ended",
        stopReason: response.stopReason,
      });
    })
    .catch((error: unknown) => {
      // Covers both a real ACP error response AND the connection dropping
      // mid-turn (`kill -9` on the machine, network blip) — `connection.agent
      // .request` rejects either way, and both are legitimately "the session
      // ended, here's why" from the browser's point of view (acceptance
      // criterion 12's "stated reason," not just criterion 12's timeout path).
      emitSessionTerminal(Promise.resolve(db), input.sessionId, {
        type: "session_ended",
        reason: `The prompt failed: ${error instanceof Error ? error.message : String(error)}`,
      });
    });

  try {
    for await (const event of events) {
      yield toStreamEventVO(event);
    }
  } finally {
    // Runs whether the loop ended because the queue closed itself (terminal
    // event) OR because the browser disconnected mid-turn (generator
    // `return()`, e.g. the tab closed) — either way, nothing should still be
    // routing session/update chunks to a consumer that's gone.
    stopWatchingSession(input.sessionId);
  }
}

/**
 * `sessionId` alone carries no tenant information — `session-relay-registry.ts`'s
 * `answerSessionPermission` is a purely in-memory lookup with no db/ownerId
 * concept at all, so without a check here any caller who guesses/observes
 * another tenant's live `sessionId` could answer THEIR pending permission
 * prompt. Resolves the session's owning agent (`getSessionAgentId`) and
 * confirms it's the caller's own (`getAgentById`, scoped to
 * `resolveOwnerId()`) before touching the relay — same non-leaking
 * `NOT_FOUND` posture as `session-events-logic.ts`'s `listSessionEvents` for
 * "no such session" vs. "belongs to another tenant". This db lookup is why
 * the function is now `async` (it used to return synchronously) — its oRPC
 * handler in `router.ts` already returns whatever this call evaluates to, so
 * no call-site change is needed: every other handler in that file already
 * returns a `Promise` from a non-`await`ed arrow body the same way.
 */
export async function answerAgentSessionPermission(
  db: Database,
  sessionId: string,
  optionId: string,
): Promise<AnswerAgentSessionPermissionOutput> {
  const agentId = await getSessionAgentId(db, sessionId);
  if (!agentId || !(await getAgentById(db, agentId))) {
    throw new ORPCError("NOT_FOUND", {
      message: `No session registered with id "${sessionId}".`,
    });
  }
  return { answered: answerSessionPermission(Promise.resolve(db), sessionId, optionId) };
}

/**
 * Best-effort `session/cancel` for a conversation nobody ever prompted —
 * found by real e2e verification of this task: `startAgentSession` always
 * spawns a real agent process, and without this, a sheet opened and closed
 * again (or React's dev-mode double effect invoke) leaves it running forever
 * with nothing that will ever send it a prompt or a cancel. Never throws —
 * this runs from a `useEffect` cleanup with no error UI to show, and a
 * machine that's already gone (bridge dropped) has nothing to notify anyway.
 *
 * Task #12: a successful cancel also marks the session row `"ended"` —
 * unconditionally, and never through `emitSessionTerminal` (see
 * `markSessionEnded`'s doc comment for why this is the ONE status
 * transition that always wins over whatever the in-flight turn resolves to
 * afterward).
 *
 * Task #13: for `remote-acp`, ALSO closes the per-session socket
 * (`closeRemoteSessionConnection`) — unlike a `bridged` machine's shared
 * bridge, which must outlive this one session, a `remote-acp` connection
 * belongs to exactly this session and would otherwise leak (spec's
 * per-session-not-persistent design for this kind — see
 * `remote-session-registry.ts`). Closing happens AFTER the best-effort
 * `session/cancel` notify, not before, so the notify has a live socket to
 * go out on.
 */
export async function endAgentSession(
  db: Database,
  input: { agentId: string; sessionId: string },
): Promise<{ ok: boolean }> {
  try {
    const { agent, connection } = await resolveConnectionForExistingSession(
      db,
      input.agentId,
      input.sessionId,
    );
    await connection.agent.notify(acp.methods.agent.session.cancel, {
      sessionId: input.sessionId,
    });
    if (agent.kind === "remote-acp") {
      closeRemoteSessionConnection(input.sessionId);
    }
    void markSessionEnded(db, input.sessionId).catch((error: unknown) => {
      console.error(
        `[acprouter] failed to mark session ended sessionId=${input.sessionId}: ${String(error)}`,
      );
    });
    return { ok: true };
  } catch {
    return { ok: false };
  }
}
