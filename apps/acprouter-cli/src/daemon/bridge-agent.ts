import type { ChildProcessWithoutNullStreams } from "node:child_process";
import type { BridgeInitializeMeta, BridgeSessionMeta } from "@acprouter/contract";
import * as acp from "@agentclientprotocol/sdk";
import type { AuthStatus } from "../config";
import { detectAgent } from "../detect";
import { resolveAgentDistribution, type SpawnSpec } from "./agent-distribution";
import { type SpawnedAgent, spawnAndInitializeAgent } from "./agent-spawn";

/**
 * One live `session/new` → spawned-process turn (spec §5.4: "one agent
 * *process* per session, not per socket"). Keyed by the sessionId the inner
 * agent returned, which is also the sessionId handed back to the Router
 * unchanged — one id, not two schemes, per the task's own steer.
 */
interface BridgeSession {
  registrySlug: string;
  child: ChildProcessWithoutNullStreams;
  inner: acp.ClientConnection;
  response: acp.LoadSessionResponse;
  activePrompt: symbol | null;
}

export interface BridgeAgentDeps {
  /** This machine's own configured working directory (spec §5.6/§8.2) — never the Router's. */
  dir: string;
  /**
   * The catalog slug this bridge is configured for (`DeviceConfig.intendedAgentSlug`), if any —
   * echoed on the `initialize` response `_meta` (task #10) so the Router can attribute a
   * `machines/agents` row without a second channel. Absent/null on a machine enrolled with no
   * intended agent.
   */
  registrySlug?: string | null;
  /** `DeviceConfig.authStatus` (task #9) — reported the same way, on the same `_meta`. */
  authStatus?: AuthStatus | null;
  log?: (line: string) => void;
  /**
   * Defaults to `resolveAgentDistribution` (the real pinned-registry
   * lookup). Overridable ONLY so `bridge-agent.integration.test.ts` can
   * point a test slug at a real-but-fake `node`-spawned ACP agent instead of
   * an actual `npx` download — the invariant this exists to protect
   * (registry-only spawning, spec §8.2) is unaffected: production code never
   * passes this, so `createBridgeAgentApp` always falls back to the real
   * pinned lookup there.
   */
  resolveDistribution?: (registrySlug: string) => SpawnSpec | null;
}

export interface BridgeAgentHandle {
  app: acp.AgentApp;
  /** Kills every still-live spawned agent process and closes its inner connection — called on bridge shutdown so a dead Router connection never leaves an orphaned `npx` process behind. */
  disposeAllSessions(): Promise<void>;
}

/**
 * Reads `_meta.registrySlug` off a `session/new` request. ACP's
 * `NewSessionRequest` has no field for "which agent" — by design, ACP
 * assumes one client talks to one already-chosen agent — so `_meta` (the
 * protocol's own named extension point, "reserved... to attach additional
 * metadata") is where this Router/CLI-specific pair agrees on it. This is
 * NOT a free-text command (invariant 1, spec §8.2): it is a slug that only
 * resolves against the pinned registry below, and any other value fails
 * closed via `resolveAgentDistribution` returning `null`.
 */
function readRegistrySlug(params: acp.NewSessionRequest | acp.LoadSessionRequest): string | null {
  const meta = params._meta;
  if (!meta || typeof meta !== "object") return null;
  const value = (meta as Record<string, unknown>).registrySlug;
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * The machine's ACP AGENT app (spec §5.1/§5.4), now with a real spawn step
 * (task #8). Two invariants from spec §8.2 are enforced entirely in this
 * file, not negotiated with the Router at all:
 *
 * 1. Registry-only spawning — `resolveAgentDistribution` is the only path
 *    from a Router-supplied string to `child_process.spawn`, and it only
 *    ever produces `npx <pinned package>@<pinned version>`. There is no
 *    field anywhere in this handler that takes a command/args from the
 *    Router and hands it to `spawn`.
 * 2. Local-only cwd — every `NewSessionRequest` sent to the spawned
 *    process uses `deps.dir`, never `ctx.params.cwd`. `ctx.params.cwd` is
 *    never read anywhere below.
 *
 * A third, non-obvious spawn primitive falls out of the same threat model
 * and is closed the same way: `NewSessionRequest.mcpServers` can itself
 * carry a `{ type: "stdio", command, args }` entry — the wrapped agent, not
 * this bridge, would spawn *that* on the Router's behalf. Forwarding the
 * Router's `mcpServers` verbatim would reopen invariant 1 through a side
 * door, so it is always forced to `[]` here too, along with
 * `additionalDirectories` (a Router-controlled filesystem-scope expansion,
 * same class of risk as `cwd`). Neither is in the MVP's scope to configure
 * per spec §5.6 (only `dir`, chosen locally, is), so there is nothing
 * legitimate being dropped yet.
 */
export function createBridgeAgentApp(deps: BridgeAgentDeps): BridgeAgentHandle {
  const sessions = new Map<acp.SessionId, BridgeSession>();
  const loading = new Map<acp.SessionId, Promise<BridgeSession>>();
  const log = deps.log ?? (() => {});
  const resolveDistribution = deps.resolveDistribution ?? resolveAgentDistribution;
  let routerConnection: acp.AgentConnection | null = null;
  let disposed = false;
  let reportedDisconnected = false;
  const pendingUpdates = new Map<acp.SessionId, Set<Promise<void>>>();

  function routerClient(): acp.AgentContext {
    if (!routerConnection || routerConnection.signal.aborted) {
      throw acp.RequestError.internalError(null, "Router connection is unavailable");
    }
    return routerConnection.client;
  }

  function reportDroppedUpdate(error: unknown): void {
    if (reportedDisconnected) return;
    reportedDisconnected = true;
    log(`dropping session updates until the Router reconnects: ${String(error)}`);
  }

  function resolveSessionSlug(
    params: acp.NewSessionRequest | acp.LoadSessionRequest,
    liveSlug?: string,
  ): string {
    const requestedSlug = readRegistrySlug(params);
    if (params._meta?.registrySlug !== undefined && !requestedSlug) {
      throw acp.RequestError.invalidParams(null, "invalid _meta.registrySlug");
    }
    if (deps.registrySlug && requestedSlug && deps.registrySlug !== requestedSlug) {
      throw acp.RequestError.invalidParams(
        null,
        "registrySlug does not match this bridge's configured agent",
      );
    }
    const slug = deps.registrySlug || requestedSlug || liveSlug;
    if (!slug) {
      throw acp.RequestError.invalidParams(
        null,
        "session/new and session/load require a configured agent or _meta.registrySlug",
      );
    }
    return slug;
  }

  function closeSession(session: Pick<BridgeSession, "child" | "inner">): void {
    session.inner.close(new Error("bridge session closed"));
    if (session.child.exitCode === null && !session.child.killed) session.child.kill();
  }

  async function spawnSession(registrySlug: string): Promise<SpawnedAgent> {
    const spawned = await spawnAndInitializeAgent({
      registrySlug,
      dir: deps.dir,
      log,
      resolveDistribution,
      onSessionUpdate: (innerCtx) => {
        const session = sessions.get(innerCtx.params.sessionId);
        const update = innerCtx.params.update;
        if (session && update.sessionUpdate === "config_option_update") {
          session.response.configOptions = update.configOptions;
        } else if (session?.response.modes && update.sessionUpdate === "current_mode_update") {
          session.response.modes = {
            ...session.response.modes,
            currentModeId: update.currentModeId,
          };
        }
        // Resolve the current connection for every delivery. No queue or retry:
        // delivery across a lost connection has an uncertain outcome.
        try {
          const client = routerClient();
          const pending = pendingUpdates.get(innerCtx.params.sessionId) ?? new Set<Promise<void>>();
          pendingUpdates.set(innerCtx.params.sessionId, pending);
          const delivery = client
            .notify(acp.methods.client.session.update, innerCtx.params)
            .catch(reportDroppedUpdate);
          pending.add(delivery);
          void delivery.finally(() => {
            pending.delete(delivery);
            if (pending.size === 0) pendingUpdates.delete(innerCtx.params.sessionId);
          });
        } catch (error) {
          reportDroppedUpdate(error);
        }
      },
      onRequestPermission: (innerCtx) =>
        routerClient().request(acp.methods.client.session.requestPermission, innerCtx.params),
    });
    if (disposed) {
      closeSession(spawned);
      throw acp.RequestError.internalError(null, "bridge is shutting down");
    }
    return spawned;
  }

  function rememberSession(
    sessionId: acp.SessionId,
    spawned: SpawnedAgent,
    response: acp.LoadSessionResponse,
  ): BridgeSession {
    if (disposed || spawned.inner.signal.aborted || spawned.child.exitCode !== null) {
      closeSession(spawned);
      throw acp.RequestError.internalError(null, "spawned agent session is no longer available");
    }
    if (sessions.has(sessionId)) {
      closeSession(spawned);
      throw acp.RequestError.invalidParams({ sessionId }, "bridge session already exists");
    }
    const session: BridgeSession = {
      registrySlug: spawned.registrySlug,
      child: spawned.child,
      inner: spawned.inner,
      response: {
        ...response,
        _meta: {
          ...(response._meta ?? {}),
          promptCapabilities: spawned.initializeResult.agentCapabilities?.promptCapabilities ?? {},
        } satisfies BridgeSessionMeta & Record<string, unknown>,
      },
      activePrompt: null,
    };
    sessions.set(sessionId, session);
    const forget = () => {
      // A late close from a replaced child must not remove its replacement.
      if (sessions.get(sessionId) === session) sessions.delete(sessionId);
    };
    spawned.child.once("exit", (code, signal) => {
      log(
        `${spawned.registrySlug} subprocess exited (code=${code ?? "null"} signal=${signal ?? "null"})`,
      );
      forget();
    });
    spawned.inner.closed
      .catch(() => undefined)
      .finally(() => {
        forget();
        closeSession(session);
      });
    return session;
  }

  async function restoreSession(params: acp.LoadSessionRequest): Promise<BridgeSession> {
    const registrySlug = resolveSessionSlug(params);
    const spawned = await spawnSession(registrySlug);
    try {
      if (!spawned.initializeResult.agentCapabilities?.loadSession) {
        throw acp.RequestError.invalidParams(
          { sessionId: params.sessionId, registrySlug },
          "configured agent does not support loading an existing ACP session",
        );
      }
      const response = await spawned.inner.agent.request(acp.methods.agent.session.load, {
        sessionId: params.sessionId,
        cwd: deps.dir,
        additionalDirectories: [],
        mcpServers: [],
      });
      await Promise.all(pendingUpdates.get(params.sessionId) ?? []);
      return rememberSession(params.sessionId, spawned, response);
    } catch (error) {
      closeSession(spawned);
      throw error;
    }
  }

  const app = acp
    .agent({ name: "acprouter-cli" })
    .onConnect((connection) => {
      routerConnection = connection;
      reportedDisconnected = false;
      connection.closed
        .catch(() => undefined)
        .finally(() => {
          if (routerConnection === connection) routerConnection = null;
        });
    })
    .onRequest(acp.methods.agent.initialize, () => {
      // Reports task #10's new facts on the SAME handshake the Router
      // already performs, rather than a second connection or a poll
      // (spec §5.6 point 5's dashboard-must-show-cwd bar, and task #9's
      // deferred authStatus question). Detected fresh here, not read back
      // from whatever `connect` found once — this handler runs on every
      // reconnect, so a version bump between connects is reflected on the
      // next one rather than going stale for the bridge process's lifetime.
      const registrySlug = deps.registrySlug ?? null;
      const detection = registrySlug ? detectAgent(registrySlug) : null;
      const meta: BridgeInitializeMeta = {
        registrySlug,
        cwd: deps.dir,
        detectedVersion: detection?.version ?? null,
        authState: deps.authStatus?.state ?? null,
        authDetail:
          deps.authStatus && deps.authStatus.state !== "ok" ? deps.authStatus.detail : null,
      };
      return {
        protocolVersion: acp.PROTOCOL_VERSION,
        agentCapabilities: { loadSession: true },
        authMethods: [],
        _meta: meta,
      };
    })
    .onRequest(acp.methods.agent.session.new, async (ctx) => {
      const registrySlug = resolveSessionSlug(ctx.params);
      const spawned = await spawnSession(registrySlug);
      const { child, inner } = spawned;

      let newSession: acp.NewSessionResponse;
      try {
        newSession = await inner.agent.request(acp.methods.agent.session.new, {
          cwd: deps.dir,
          additionalDirectories: [],
          mcpServers: [],
        });
      } catch (error) {
        closeSession({ child, inner });
        if (error instanceof acp.RequestError) throw error;
        throw acp.RequestError.internalError(
          { registrySlug },
          `spawned agent failed to initialize: ${error instanceof Error ? error.message : String(error)}`,
        );
      }

      const { sessionId, ...response } = newSession;
      const session = rememberSession(sessionId, spawned, response);

      // Forwarded in full, not just `{ sessionId }` — `modes`/`configOptions`/
      // `_meta` are the spawned agent's real negotiated capabilities (spec
      // §5.2a: "capabilities must be negotiated from `initialize`, never
      // assumed"), and the Router has no other way to learn them.
      //
      // `promptCapabilities` has to be added on top rather than being part of
      // `newSession` already: it comes from the spawned agent's `initialize`,
      // not its `session/new`. Without it the Router cannot tell whether THIS
      // session's agent accepts images, audio or embedded resources — the
      // bridge's own `initialize` reports only what the CLI implements, and
      // the agent behind it does not even exist until this handler runs.
      // Spread so an agent's own `session/new` `_meta` is preserved, not
      // replaced.
      return {
        sessionId,
        ...session.response,
      };
    })
    .onRequest(acp.methods.agent.session.load, async (ctx) => {
      const sessionId = ctx.params.sessionId;
      let session = sessions.get(sessionId);
      if (session && (session.inner.signal.aborted || session.child.exitCode !== null)) {
        sessions.delete(sessionId);
        closeSession(session);
        session = undefined;
      }
      if (session) {
        const registrySlug = resolveSessionSlug(ctx.params, session.registrySlug);
        if (registrySlug !== session.registrySlug) {
          throw acp.RequestError.invalidParams(
            null,
            "registrySlug does not match the existing session",
          );
        }
        if (session.activePrompt) {
          throw acp.RequestError.invalidParams(
            { sessionId, reason: "session_busy" },
            "bridge session still has an active prompt; wait for it to finish before loading",
          );
        }
        // The live process already owns the conversation; loading it again
        // could reset or duplicate work. Only a missing process needs load.
        return session.response;
      }
      let pending = loading.get(sessionId);
      if (!pending) {
        pending = restoreSession(ctx.params);
        loading.set(sessionId, pending);
      }
      try {
        session = await pending;
        if (resolveSessionSlug(ctx.params) !== session.registrySlug) {
          throw acp.RequestError.invalidParams(
            null,
            "registrySlug does not match the existing session",
          );
        }
        return session.response;
      } finally {
        if (loading.get(sessionId) === pending) loading.delete(sessionId);
      }
    })
    .onRequest(acp.methods.agent.session.prompt, async (ctx) => {
      const session = sessions.get(ctx.params.sessionId);
      if (!session) {
        throw acp.RequestError.invalidParams(
          { sessionId: ctx.params.sessionId },
          `no active bridge session for ${ctx.params.sessionId}`,
        );
      }
      if (session.activePrompt) {
        throw acp.RequestError.invalidParams(
          { sessionId: ctx.params.sessionId, reason: "session_busy" },
          "bridge session still has an active prompt",
        );
      }
      const promptToken = Symbol("active prompt");
      session.activePrompt = promptToken;
      // Flush updates already emitted by the child before the terminal
      // response closes the Router's event stream. Never retry the prompt.
      try {
        const result = await session.inner.agent.request(
          acp.methods.agent.session.prompt,
          ctx.params,
        );
        await Promise.all(pendingUpdates.get(ctx.params.sessionId) ?? []);
        return result;
      } finally {
        // The child, rather than the outer socket, owns this lock. Closing
        // an outer request cannot permit another turn while it still runs.
        if (session.activePrompt === promptToken) session.activePrompt = null;
      }
    })
    .onNotification(acp.methods.agent.session.cancel, (ctx) => {
      const session = sessions.get(ctx.params.sessionId);
      if (!session) return; // nothing in flight for this id — accept-and-ignore, same posture as before task #8
      void session.inner.agent
        .notify(acp.methods.agent.session.cancel, ctx.params)
        .catch((error) => {
          log(`failed to relay session/cancel to ${session.registrySlug}: ${String(error)}`);
        });
    });

  async function disposeAllSessions(): Promise<void> {
    disposed = true;
    const live = [...sessions.values()];
    sessions.clear();
    await Promise.all(live.map(async (session) => closeSession(session)));
  }

  return { app, disposeAllSessions };
}
