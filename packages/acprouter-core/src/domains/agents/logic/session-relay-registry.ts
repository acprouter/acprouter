import type { AgentSessionStreamEventVO } from "@acprouter/contract";
import type * as acp from "@agentclientprotocol/sdk";
import type { Database } from "../../../db";
import { appendSessionEvent } from "./session-events-logic";
import { markSessionFailed, markSessionIdle } from "./session-status-logic";

/**
 * In-memory, per-`session/new`-id relay (task #11) — `machine-bridge-registry.ts`
 * is one entry per connected MACHINE; this is one entry per SESSION, because
 * a browser watching a prompt-box conversation needs its `session/update`s
 * and `session/request_permission`s routed to IT specifically, not
 * broadcast to every tab or (worse) auto-answered by the backend. Same
 * `globalThis`-caching reasoning as that file (Next.js dev-mode module-graph
 * duplication would otherwise mint a second, empty registry that the WS
 * route and the oRPC streaming procedure would disagree about).
 *
 * Task #12: every event this file relays is ALSO persisted to
 * `acprouter_agent_session_events`, fire-and-forget, independent of whether
 * a browser is currently watching (`queue` may be null) — that independence
 * is the entire point: a browser tab closing mid-turn must not stop the rest
 * of that turn from being durably recorded, since ACP v1 has no
 * transport-level resume (spec §5.4) and this table is what stands in for
 * one. The relay-to-browser path (`queue.push`) and the persistence path
 * never block each other — see `persistEvent`'s doc comment.
 */

export const DEFAULT_PERMISSION_TIMEOUT_MS = 5 * 60 * 1000;

export type SessionStreamEvent =
  | { type: "session_update"; update: acp.SessionUpdate }
  | {
      type: "permission_request";
      toolCall: acp.ToolCallUpdate;
      options: acp.PermissionOption[];
      requestedAt: string;
      timeoutAt: string;
    }
  | { type: "permission_resolved"; optionId: string }
  | { type: "turn_ended"; stopReason: acp.StopReason }
  | { type: "session_ended"; reason: string };

/** The internal relay shape → the exact wire shape the browser receives (`AgentSessionStreamEventVO`) — also what gets persisted as `payload` (task #12), so history read back later is byte-identical to what a live viewer saw. Exported for `sessions-logic.ts`'s own `for await` loop, which yields this same mapping to the browser. */
export function toStreamEventVO(event: SessionStreamEvent): AgentSessionStreamEventVO {
  switch (event.type) {
    case "session_update":
      return { type: "session_update", update: event.update };
    case "permission_request":
      return {
        type: "permission_request",
        toolCall: event.toolCall,
        options: event.options,
        requestedAt: event.requestedAt,
        timeoutAt: event.timeoutAt,
      };
    case "permission_resolved":
      return { type: "permission_resolved", optionId: event.optionId };
    case "turn_ended":
      return { type: "turn_ended", stopReason: event.stopReason };
    case "session_ended":
      return { type: "session_ended", reason: event.reason };
    default:
      return event satisfies never;
  }
}

interface EventQueue<T> {
  push: (item: T) => void;
  close: () => void;
  iterate: () => AsyncGenerator<T, void, void>;
}

/**
 * A minimal pull-based async queue: `push` is synchronous and never blocks
 * (the producer side — ACP notification handlers — must never await a slow
 * consumer), `iterate()` is what the oRPC `eventIterator` procedure hands
 * back to `@orpc/server` to drive the stream. No external library for
 * this — the whole thing is ~25 lines and every alternative considered
 * (Node's `EventEmitter` + a manual async-iterator wrapper, a
 * `TransformStream`) is strictly more code for the same behavior.
 */
function createEventQueue<T>(): EventQueue<T> {
  const buffered: T[] = [];
  let pendingResolve: ((result: IteratorResult<T, void>) => void) | null = null;
  let closed = false;

  function push(item: T): void {
    if (closed) return;
    if (pendingResolve) {
      const resolve = pendingResolve;
      pendingResolve = null;
      resolve({ value: item, done: false });
    } else {
      buffered.push(item);
    }
  }

  function close(): void {
    if (closed) return;
    closed = true;
    if (pendingResolve) {
      const resolve = pendingResolve;
      pendingResolve = null;
      resolve({ value: undefined, done: true });
    }
  }

  async function* iterate(): AsyncGenerator<T, void, void> {
    while (true) {
      const next = buffered.shift();
      if (next !== undefined || buffered.length > 0) {
        // `shift()` returning `undefined` is ambiguous with "queue empty" only
        // when a real event value IS `undefined`, which none of ours ever are
        // (all `SessionStreamEvent` variants are objects) — the `.length`
        // check above is belt-and-suspenders, not load-bearing.
        yield next as T;
        continue;
      }
      if (closed) return;
      const result = await new Promise<IteratorResult<T, void>>((resolve) => {
        pendingResolve = resolve;
      });
      if (result.done) return;
      yield result.value;
    }
  }

  return { push, close, iterate };
}

interface PendingPermission {
  resolve: (outcome: acp.RequestPermissionOutcome) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface SessionRelay {
  queue: EventQueue<SessionStreamEvent> | null;
  pendingPermission: PendingPermission | null;
}

type GlobalWithSessionRelays = typeof globalThis & {
  __acprouterSessionRelays?: Map<string, SessionRelay>;
};

function getRegistry(): Map<string, SessionRelay> {
  const g = globalThis as GlobalWithSessionRelays;
  if (!g.__acprouterSessionRelays) {
    g.__acprouterSessionRelays = new Map();
  }
  return g.__acprouterSessionRelays;
}

function getOrCreateRelay(sessionId: string): SessionRelay {
  const registry = getRegistry();
  let relay = registry.get(sessionId);
  if (!relay) {
    relay = { queue: null, pendingPermission: null };
    registry.set(sessionId, relay);
  }
  return relay;
}

/** Deletes the entry once there is nothing left to route — no queue watching it and no permission timer pending — so this map doesn't grow forever across a long-lived Router process. */
function pruneIfEmpty(sessionId: string): void {
  const registry = getRegistry();
  const relay = registry.get(sessionId);
  if (relay && !relay.queue && !relay.pendingPermission) {
    registry.delete(sessionId);
  }
}

type GlobalWithSessionEventSeqs = typeof globalThis & {
  __acprouterSessionEventSeqs?: Map<string, number>;
};

/**
 * Deliberately a SEPARATE map from `getRegistry()`'s relay map, not a field
 * on `SessionRelay` — that object is pruned the instant nobody is watching
 * AND no permission is pending (`pruneIfEmpty`), which happens after every
 * single turn once the browser's `for await` loop returns. But one session's
 * event log spans MANY turns (`sessions.prompt` is called once per user
 * message, re-attaching `watchSession` each time) — a counter stored on the
 * pruned relay object would silently reset to 0 on the very next turn and
 * collide with the unique `(sessionId, seq)` index. This map survives that
 * pruning; it is cleared only in `clearSeq`, once a session truly ends.
 */
function getSeqCounters(): Map<string, number> {
  const g = globalThis as GlobalWithSessionEventSeqs;
  if (!g.__acprouterSessionEventSeqs) {
    g.__acprouterSessionEventSeqs = new Map();
  }
  return g.__acprouterSessionEventSeqs;
}

function nextSeq(sessionId: string): number {
  const counters = getSeqCounters();
  const seq = (counters.get(sessionId) ?? 0) + 1;
  counters.set(sessionId, seq);
  return seq;
}

/**
 * A Router process restart loses this counter along with every other piece
 * of this file's in-memory state — confirmed as NOT a new failure mode: the
 * whole in-memory session already dies with the process per task #11's
 * design (a restarted Router holds no live bridge connection to resume a
 * session on, and ACP v1 itself has no transport-level resume — spec §5.4 —
 * so there is no live agent process left that could ever emit another event
 * for this `sessionId` after a restart). A restart therefore cannot produce
 * a seq collision, because it cannot produce any MORE events for a session
 * it no longer has a connection to.
 */
function clearSeq(sessionId: string): void {
  getSeqCounters().delete(sessionId);
}

/**
 * Fire-and-forget, never awaited by any caller — the relay's synchronous
 * push to the browser's queue (this file's core contract; see
 * `createEventQueue`'s doc comment) must never wait on a DB round trip.
 * `seq` is assigned SYNCHRONOUSLY, in true emission order, before the async
 * write is kicked off, so ordering is correct even though the underlying
 * inserts' completion order is not guaranteed.
 */
function persistEvent(
  dbPromise: Promise<Database>,
  sessionId: string,
  event: SessionStreamEvent,
): void {
  const seq = nextSeq(sessionId);
  void dbPromise
    .then((db) => appendSessionEvent(db, sessionId, seq, toStreamEventVO(event)))
    .catch((error: unknown) => {
      console.error(
        `[acprouter] failed to persist session event session=${sessionId} seq=${seq} type=${event.type}: ${String(error)}`,
      );
    });
}

/**
 * Starts watching a session's events — called once per `sessions.prompt`
 * oRPC call (task #11's streaming procedure), which is also the call that
 * sends the actual `session/prompt` request. One watcher at a time (MVP,
 * per the task brief — no multi-viewer fanout): attaching replaces any
 * previous queue for this session, closing it first so an abandoned
 * generator (e.g. a re-rendered/reconnected prompt box) doesn't leak a
 * dangling consumer that will never be read again.
 */
export function watchSession(sessionId: string): AsyncGenerator<SessionStreamEvent, void, void> {
  const relay = getOrCreateRelay(sessionId);
  relay.queue?.close();
  const queue = createEventQueue<SessionStreamEvent>();
  relay.queue = queue;
  return queue.iterate();
}

/** Called from the `prompt` procedure's `finally` (generator return, e.g. the browser tab closed mid-turn) — detaches the queue but leaves any pending permission timer running, since a user walking away mid-permission-request is exactly the scenario the timeout (criterion 12) exists for. */
export function stopWatchingSession(sessionId: string): void {
  const relay = getRegistry().get(sessionId);
  if (relay) {
    relay.queue = null;
    pruneIfEmpty(sessionId);
  }
}

/** Routes a real `session/update` notification to whatever's currently watching this session (a no-op push if nobody is — browser tab never opened, or already closed; no buffering, see this file's module doc comment), and ALWAYS persists it (task #12), live watcher or not. Called from `machine-bridge-connection.ts`, which is why `dbPromise` — not a resolved `db` — is the parameter: the notification handler that calls this is wired synchronously, before `db` itself has resolved (see that file's own doc comment on the same constraint). */
export function emitSessionUpdate(
  dbPromise: Promise<Database>,
  sessionId: string,
  update: acp.SessionUpdate,
): void {
  const event: SessionStreamEvent = { type: "session_update", update };
  getRegistry().get(sessionId)?.queue?.push(event);
  persistEvent(dbPromise, sessionId, event);
}

/**
 * Pushes a terminal event (`turn_ended`/`session_ended`) and closes the
 * queue if anyone's watching — the browser's `for await` loop over
 * `sessions.prompt` ends right after receiving it. Persistence AND the
 * `acprouter_agent_sessions.status` transition (task #12) now happen
 * unconditionally, even if nobody's watching: previously (task #11) a
 * terminal event with no live queue was a complete no-op, which was fine
 * when nothing durable depended on it — it is exactly the "browser tab
 * closed mid-turn" case this task exists to stop losing. `turn_ended` reads
 * as `"idle"` (the session is still open for another prompt); `session_ended`
 * reads as `"failed"` (every `session_ended` THIS FILE emits is an abnormal
 * stop — see `markSessionFailed`'s doc comment for why a real user cancel
 * never reaches this function at all).
 */
export function emitSessionTerminal(
  dbPromise: Promise<Database>,
  sessionId: string,
  event: Extract<SessionStreamEvent, { type: "turn_ended" | "session_ended" }>,
): void {
  const relay = getRegistry().get(sessionId);
  if (relay?.queue) {
    relay.queue.push(event);
    relay.queue.close();
    relay.queue = null;
  }
  pruneIfEmpty(sessionId);
  persistEvent(dbPromise, sessionId, event);

  void dbPromise
    .then((db) =>
      event.type === "turn_ended"
        ? markSessionIdle(db, sessionId)
        : markSessionFailed(db, sessionId),
    )
    .catch((error: unknown) => {
      console.error(
        `[acprouter] failed to update session status session=${sessionId} type=${event.type}: ${String(error)}`,
      );
    });

  if (event.type === "session_ended") {
    // The session's event log is genuinely over — nothing will ever emit
    // another event for this `sessionId` again (see `clearSeq`'s doc
    // comment). `turn_ended` deliberately does NOT clear it: the session is
    // still open for another prompt, which reuses this same counter.
    clearSeq(sessionId);
  }
}

export interface RequestSessionPermissionOptions {
  timeoutMs?: number;
  /** Best-effort side effect fired only on the TIMEOUT path (not on a real browser answer) — `machine-bridge-connection.ts` uses this to notify `session/cancel` to the spawned agent, so a permission request nobody answers doesn't just stop informing the browser while the agent keeps running unsupervised. */
  onTimeout?: () => void;
}

/**
 * Registers a pending `session/request_permission` and returns a promise
 * that resolves either from a real browser answer (`answerSessionPermission`)
 * or — chrome-acp's reference number, spec §5.5a — a 5-minute timeout that
 * resolves `{ outcome: { outcome: "cancelled" } }` on its own. This is what
 * makes acceptance criterion 12 true regardless of whether anyone is
 * watching: the timer is armed here, independent of `queue` — a session with
 * no attached browser still gets a real `cancelled` answer instead of
 * hanging the spawned agent process forever. NEVER falls back to
 * auto-allow — that is the exact failure mode (spec §3 "silent
 * auto-approval") this task exists to remove; "nobody's watching" resolves
 * `cancelled` after the timeout, same as "somebody's watching but never
 * clicked," never `selected`.
 */
export function requestSessionPermission(
  dbPromise: Promise<Database>,
  sessionId: string,
  toolCall: acp.ToolCallUpdate,
  options: acp.PermissionOption[],
  opts: RequestSessionPermissionOptions = {},
): Promise<acp.RequestPermissionOutcome> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_PERMISSION_TIMEOUT_MS;
  const relay = getOrCreateRelay(sessionId);

  // Defensive, not expected in practice: ACP does not overlap permission
  // requests within one session. If it ever happened, letting the new one
  // silently orphan the old one's timer/promise would leak both — instead
  // the stale one is resolved `cancelled` immediately, same outcome as if
  // its own timeout had fired.
  if (relay.pendingPermission) {
    clearTimeout(relay.pendingPermission.timer);
    relay.pendingPermission.resolve({ outcome: "cancelled" });
    relay.pendingPermission = null;
  }

  const requestedAt = new Date();
  const timeoutAt = new Date(requestedAt.getTime() + timeoutMs);

  return new Promise<acp.RequestPermissionOutcome>((resolve) => {
    const timer = setTimeout(() => {
      relay.pendingPermission = null;
      resolve({ outcome: "cancelled" });
      emitSessionTerminal(dbPromise, sessionId, {
        type: "session_ended",
        reason: `No response to the permission request within ${Math.round(timeoutMs / 1000)}s — session ended.`,
      });
      opts.onTimeout?.();
      pruneIfEmpty(sessionId);
    }, timeoutMs);

    relay.pendingPermission = { resolve, timer };
    const event: SessionStreamEvent = {
      type: "permission_request",
      toolCall,
      options,
      requestedAt: requestedAt.toISOString(),
      timeoutAt: timeoutAt.toISOString(),
    };
    relay.queue?.push(event);
    persistEvent(dbPromise, sessionId, event);
  });
}

/**
 * Resolves a pending `session/request_permission` with a REAL ACP outcome —
 * generalized (task #14) from what used to be `answerSessionPermission`'s
 * body, hard-coded to `{outcome:"selected", optionId}`. The reason to widen
 * it rather than add a second resolution path: an external ACP consumer
 * (task #14's new `wss://.../api/acp` surface) answers a forwarded
 * `session/request_permission` through ITS OWN real ACP response, which —
 * unlike the dashboard's Allow/Deny buttons — can legitimately BE
 * `{outcome:"cancelled"}` (a real ACP client is allowed to decline to
 * answer). That answer has to resolve the exact same `pendingPermission`
 * promise/timer pair the dashboard's click always has, so both callers now
 * go through this one function instead of the consumer path needing a
 * second, parallel way to reach into `pendingPermission` — which is the
 * "smallest generalization" this task's brief asked for: nothing about the
 * timer, the timeout-never-falls-back-to-auto-allow contract, or the queue
 * wiring below changes at all, only the shape of what can resolve it.
 */
export function resolveSessionPermission(
  dbPromise: Promise<Database>,
  sessionId: string,
  outcome: acp.RequestPermissionOutcome,
): boolean {
  const relay = getRegistry().get(sessionId);
  const pending = relay?.pendingPermission;
  if (!relay || !pending) return false;

  clearTimeout(pending.timer);
  relay.pendingPermission = null;
  pending.resolve(outcome);
  if (outcome.outcome === "selected") {
    const event: SessionStreamEvent = { type: "permission_resolved", optionId: outcome.optionId };
    relay.queue?.push(event);
    persistEvent(dbPromise, sessionId, event);
  }
  // A `cancelled` outcome pushes no display event — there is no real click to
  // show as "resolved," and the dashboard never produces this outcome itself
  // (see the doc comment above); an external consumer declining is silent to
  // any dashboard viewer the same way a bridged agent losing its socket
  // silently stops emitting further updates, rather than announcing it.
  pruneIfEmpty(sessionId);
  return true;
}

/**
 * A real browser answer arriving in time. Returns `false` (not an error —
 * the UI shows this as "too late") when the timeout already fired or
 * nothing was ever pending for this session, so the caller can tell "your
 * click landed" from "the 5 minutes were already up." Always resolves
 * `{ outcome: "selected", optionId }` — never synthesizes `cancelled` from a
 * real click; that outcome is reserved for the timeout path (and, since task
 * #14, a real external consumer's own explicit decline via
 * `resolveSessionPermission`).
 */
export function answerSessionPermission(
  dbPromise: Promise<Database>,
  sessionId: string,
  optionId: string,
): boolean {
  return resolveSessionPermission(dbPromise, sessionId, { outcome: "selected", optionId });
}
