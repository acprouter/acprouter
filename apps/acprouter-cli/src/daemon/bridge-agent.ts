import type { ChildProcessWithoutNullStreams } from "node:child_process";
import type { BridgeInitializeMeta } from "@acprouter/contract";
import * as acp from "@agentclientprotocol/sdk";
import type { AuthStatus } from "../config";
import { detectAgent } from "../detect";
import { resolveAgentDistribution, type SpawnSpec } from "./agent-distribution";
import { spawnAndInitializeAgent } from "./agent-spawn";

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
function readRegistrySlug(params: acp.NewSessionRequest): string | null {
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
  const log = deps.log ?? (() => {});
  const resolveDistribution = deps.resolveDistribution ?? resolveAgentDistribution;

  const app = acp
    .agent({ name: "acprouter-cli" })
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
        agentCapabilities: { loadSession: false },
        authMethods: [],
        _meta: meta,
      };
    })
    .onRequest(acp.methods.agent.session.new, async (ctx) => {
      const registrySlug = readRegistrySlug(ctx.params);
      if (!registrySlug) {
        throw acp.RequestError.invalidParams(
          { reason: "missing__meta.registrySlug" },
          "session/new requires _meta.registrySlug identifying which pinned agent to spawn",
        );
      }

      // Captured once here, per-session — connection-scoped (see
      // `AgentHandlerContext.client`'s doc comment), so the inner
      // connection's handlers below can keep using it for the rest of the
      // session's life without threading it through every call.
      const outerClient = ctx.client;
      const spawned = await spawnAndInitializeAgent({
        registrySlug,
        dir: deps.dir,
        log: (line) => log(`session/new: ${line}`),
        resolveDistribution,
        onSessionUpdate: (innerCtx) => {
          void outerClient
            .notify(acp.methods.client.session.update, innerCtx.params)
            .catch((error) => {
              log(`failed to relay session/update to Router: ${String(error)}`);
            });
        },
        onRequestPermission: (innerCtx) =>
          outerClient.request(acp.methods.client.session.requestPermission, innerCtx.params),
      });
      const { child, inner } = spawned;

      let newSession: acp.NewSessionResponse;
      try {
        newSession = await inner.agent.request(acp.methods.agent.session.new, {
          cwd: deps.dir,
          additionalDirectories: [],
          mcpServers: [],
        });
      } catch (error) {
        child.kill();
        inner.close(error);
        if (error instanceof acp.RequestError) throw error;
        throw acp.RequestError.internalError(
          { registrySlug },
          `spawned agent failed to initialize: ${error instanceof Error ? error.message : String(error)}`,
        );
      }

      const sessionId = newSession.sessionId;
      sessions.set(sessionId, { registrySlug, child, inner });

      child.once("exit", (code, signal) => {
        log(
          `${registrySlug} subprocess exited (code=${code ?? "null"} signal=${signal ?? "null"})`,
        );
        sessions.delete(sessionId);
      });
      inner.closed
        .catch(() => undefined)
        .finally(() => {
          sessions.delete(sessionId);
          if (child.exitCode === null && !child.killed) child.kill();
        });

      // Forwarded in full, not just `{ sessionId }` — `modes`/`configOptions`/
      // `_meta` are the spawned agent's real negotiated capabilities (spec
      // §5.2a: "capabilities must be negotiated from `initialize`, never
      // assumed"), and the Router has no other way to learn them.
      return newSession;
    })
    .onRequest(acp.methods.agent.session.prompt, async (ctx) => {
      const session = sessions.get(ctx.params.sessionId);
      if (!session) {
        throw acp.RequestError.invalidParams(
          { sessionId: ctx.params.sessionId },
          `no active bridge session for ${ctx.params.sessionId}`,
        );
      }
      // Same session id on both hops (1:1 mapping) — forward as-is.
      return session.inner.agent.request(acp.methods.agent.session.prompt, ctx.params);
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
    const live = [...sessions.values()];
    sessions.clear();
    await Promise.all(
      live.map(async ({ child, inner }) => {
        inner.close(new Error("bridge shutting down"));
        if (child.exitCode === null && !child.killed) child.kill();
      }),
    );
  }

  return { app, disposeAllSessions };
}
